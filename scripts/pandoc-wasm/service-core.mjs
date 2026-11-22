/* Pandoc-on-WebAssembly service used by the OHSidian renderer.
 *
 * Why WASM: HarmonyOS tablets/phones forbid `fork+exec` of app-provided
 * binaries (the desktop HNP / HAP-bin mechanisms are PC/2in1 only), and the
 * weak sandbox (CUSTOM_SANDBOX) needs a restricted ACL profile. The official
 * pandoc WASM build (github.com/pandoc/pandoc-wasm) runs the same Pandoc
 * engine inside the JS process, so PC and tablet get identical behaviour
 * without touching the sandbox or shipping native ELF files.
 *
 * This file is bundled (with pandoc-wasm's core.js and the WASI shim) by
 * scripts/build-pandoc-wasm.mjs into web_engine/src/main/resources/resfile/
 * pandoc/pandoc-service.cjs, which the renderer patch
 * scripts/patches/pandoc-wasm.js requires and wires into child_process.
 *
 * `createPandocInstance` is injected by the bundler entry point. Everything
 * here is plain CommonJS-compatible ESM so it can also be required by
 * scripts/verify-pandoc-wasm.cjs in Node for the build gate. */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const PANDOC_WASM_SERVICE_VERSION = 1;

const TEXT_EXT = new Set([
  ".md", ".markdown", ".mdown", ".mkd", ".txt", ".text", ".rst", ".org",
  ".html", ".htm", ".xhtml", ".tex", ".latex", ".ltx", ".bib", ".csl",
  ".yaml", ".yml", ".json", ".csv", ".tsv", ".lua", ".xml",
]);
const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".tif", ".tiff", ".eps",
]);
const BINARY_OUT_EXT = new Set([
  ".docx", ".odt", ".pptx", ".epub", ".pdf", ".doc", ".rtf", ".epub3",
]);
const TEXT_OUT_EXT = new Set([
  ".html", ".htm", ".txt", ".md", ".rst", ".tex", ".latex", ".org", ".rtf",
  ".json", ".xml", ".lua", ".bib", ".csl", ".adoc", ".asciidoc", ".ipynb",
]);
const EXT_TO_FORMAT = {
  ".md": "markdown", ".markdown": "markdown", ".mdown": "markdown", ".mkd": "markdown",
  ".html": "html", ".htm": "html", ".xhtml": "html", ".tex": "latex", ".latex": "latex",
  ".rst": "rst", ".org": "org", ".txt": "markdown", ".docx": "docx", ".odt": "odt",
  ".pptx": "pptx", ".epub": "epub", ".pdf": "pdf", ".rtf": "rtf", ".ipynb": "ipynb",
  ".adoc": "asciidoc", ".asciidoc": "asciidoc", ".csv": "csv", ".tsv": "tsv",
};
const FORMAT_TO_EXT = {
  docx: ".docx", odt: ".odt", pptx: ".pptx", epub: ".epub", pdf: ".pdf",
  html: ".html", html5: ".html", latex: ".tex", markdown: ".md", rst: ".rst",
  org: ".org", rtf: ".rtf", ipynb: ".ipynb", asciidoc: ".adoc", json: ".json",
};

const SHORT_VALUE_FLAGS = new Set(["f", "t", "o", "V", "M", "L", "F", "c", "d", "T", "C", "B", "A", "H", "D"]);

const VALUE_FLAGS = new Set([
  "from", "to", "output", "template", "reference-doc", "metadata-file",
  "bibliography", "csl", "filter", "lua-filter", "extract-media",
  "resource-path", "data-dir", "pdf-engine", "pdf-engine-opt", "css",
  "include-in-header", "include-before-body", "include-after-body",
  "highlight-style", "syntax-definition", "defaults", "columns", "wrap",
  "eol", "trace", "log", "shift-heading-level-by", "number-offset",
  "metadata", "variable", "input-file", "output-file", "abbreviations",
  "indented-code-classes", "request-header", "request-body",
]);
const BOOL_FLAGS = new Set([
  "standalone", "toc", "toc-depth", "number-sections", "self-contained",
  "embed-resources", "citeproc", "strip-comments", "preserve-tabs", "ascii",
  "incremental", "reference-links", "reference-location", "wrap", "smart",
  "verbose", "quiet", "sandbox", "file-scope", "list-input-formats",
  "list-output-formats", "list-extensions", "list-highlight-styles",
  "list-highlight-languages", "list-media-bag", "print-default-template",
  "print-default-data-file", "show-default-template", "show-default-data-files",
  "version", "help", "bash-completion", "no-check-certificate",
]);

/* Minimal POSIX-ish shell splitter (exec() passes a command string). Handles
 * single/double quotes and backslash escapes; no expansions/pipes. */
export function shellSplit(command) {
  const out = [];
  let cur = "";
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function isPandocCommand(command) {
  if (!command) return false;
  let cmd = String(command).trim();
  if (!cmd) return false;
  if (/^["']/.test(cmd)) cmd = cmd.replace(/^["']|["']$/g, "");
  const base = path.basename(cmd.replace(/\\/g, "/")).toLowerCase();
  return base === "pandoc" || base === "pandoc.exe";
}

export function commandBasename(command) {
  if (!command) return "";
  let cmd = String(command).trim().replace(/^["']|["']$/g, "");
  return path.basename(cmd.replace(/\\/g, "/")).toLowerCase();
}

const PANDOC_BOOLS = { s: "standalone", S: "smart", N: "number-sections", T: "table-of-contents" };

/* Parse pandoc CLI arguments. Unknown flags are passed through generically
 * (kebab-case keys are what pandoc-wasm's convert() options expect). */
export function parseArgs(argv) {
  const out = {
    inputs: [],
    from: "",
    to: "",
    output: "",
    standalone: false,
    toc: false,
    numberSections: false,
    template: "",
    referenceDoc: "",
    metadataFile: "",
    bibliography: "",
    csl: "",
    filters: [],
    luaFilters: [],
    extractMedia: "",
    resources: [],
    variables: {},
    metadata: {},
    pdfEngine: "",
    selfContained: false,
    embedResources: false,
    listInputFormats: false,
    listOutputFormats: false,
    showVersion: false,
    showHelp: false,
    unknown: [],
    raw: [],
  };
  const takeValue = (i, flag) => {
    if (i + 1 >= argv.length) return { v: "", next: i };
    return { v: argv[i + 1], next: i + 1 };
  };
  const setGeneric = (key, value) => {
    const k = key.replace(/^--/, "");
    if (k === "standalone") { out.standalone = true; return; }
    if (k === "toc") { out.toc = true; out.raw.push([k, true]); return; }
    if (k === "number-sections") { out.numberSections = true; out.raw.push([k, true]); return; }
    if (k === "template") { out.template = value; return; }
    if (k === "reference-doc") { out.referenceDoc = value; return; }
    if (k === "metadata-file") { out.metadataFile = value; return; }
    if (k === "bibliography") { out.bibliography = value; return; }
    if (k === "csl") { out.csl = value; return; }
    if (k === "pdf-engine") { out.pdfEngine = value; out.raw.push([k, value]); return; }
    if (k === "extract-media") { out.extractMedia = value; return; }
    if (k === "resource-path") { out.resources.push(value); return; }
    if (k === "self-contained" || k === "embed-resources") {
      out.selfContained = true; out.embedResources = true; out.raw.push([k, true]); return;
    }
    if (k === "filter") { out.filters.push(value); return; }
    if (k === "lua-filter") { out.luaFilters.push(value); return; }
    if (k === "metadata" || k === "variable") {
      const eq = value.indexOf("=");
      if (eq > 0) {
        const kv = { [value.slice(0, eq)]: value.slice(eq + 1) };
        if (k === "metadata") Object.assign(out.metadata, kv);
        else Object.assign(out.variables, kv);
      }
      return;
    }
    if (k === "list-input-formats") { out.listInputFormats = true; return; }
    if (k === "list-output-formats") { out.listOutputFormats = true; return; }
    if (k === "version") { out.showVersion = true; return; }
    if (k === "help") { out.showHelp = true; return; }
    if (!value) out.raw.push([k, true]);
    else out.raw.push([k, value]);
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") { out.inputs = out.inputs.concat(argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      let key = a;
      let val = null;
      const eq = a.indexOf("=");
      if (eq >= 0) { key = a.slice(0, eq); val = a.slice(eq + 1); }
      if (VALUE_FLAGS.has(key.slice(2))) {
        if (val === null) { const r = takeValue(i, key); val = r.v; i = r.next; }
        setGeneric(key, val);
      } else if (BOOL_FLAGS.has(key.slice(2)) && val === null) {
        setGeneric(key);
      } else {
        setGeneric(key, val === null ? undefined : val);
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && a !== "-") {
      const flag = a.slice(1);
      if (SHORT_VALUE_FLAGS.has(flag)) {
        const r = takeValue(i, flag);
        i = r.next;
        const v = r.v;
        if (flag === "f") out.from = v;
        else if (flag === "t") out.to = v;
        else if (flag === "o") out.output = v;
        else if (flag === "V") {
          const eq = v.indexOf("=");
          if (eq > 0) out.variables[v.slice(0, eq)] = v.slice(eq + 1);
        } else if (flag === "M") {
          const eq = v.indexOf("=");
          if (eq > 0) out.metadata[v.slice(0, eq)] = v.slice(eq + 1);
        } else if (flag === "L") out.luaFilters.push(v);
        else if (flag === "F") out.filters.push(v);
        else if (flag === "c") out.csl = v;
        else if (flag === "T") out.toc = true;
        else out.raw.push([flag, v]);
        continue;
      }
      for (const ch of flag) {
        if (PANDOC_BOOLS[ch]) {
          if (PANDOC_BOOLS[ch] === "standalone") out.standalone = true;
          else if (PANDOC_BOOLS[ch] === "table-of-contents") out.toc = true;
          else if (PANDOC_BOOLS[ch] === "number-sections") out.numberSections = true;
          else out.raw.push([ch, true]);
        } else if (SHORT_VALUE_FLAGS.has(ch)) {
          const r = takeValue(i, ch);
          i = r.next;
          out.raw.push([ch, r.v]);
          if (ch === "t") out.to = r.v;
          else if (ch === "f") out.from = r.v;
        } else {
          out.unknown.push("-" + ch);
        }
      }
      continue;
    }
    out.inputs.push(a);
  }
  return out;
}

export function inferFormatFromPath(p) {
  const ext = path.extname(String(p || "")).toLowerCase();
  return EXT_TO_FORMAT[ext] || "";
}

export function isBinaryOut(to, output) {
  const fmt = String(to || "").toLowerCase();
  if (BINARY_OUT_EXT.has("." + fmt)) return true;
  if (output && BINARY_OUT_EXT.has(path.extname(output).toLowerCase())) return true;
  return false;
}

export function isTextOut(to, output) {
  const fmt = String(to || "").toLowerCase();
  if (TEXT_OUT_EXT.has("." + fmt)) return true;
  if (output && TEXT_OUT_EXT.has(path.extname(output).toLowerCase())) return true;
  return false;
}

function readAsText(abs) {
  return fs.readFileSync(abs, "utf8");
}

function toBlob(buf) {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (typeof Blob !== "undefined") return new Blob([bytes]);
  return bytes;
}

function safeName(name, used) {
  let base = String(name || "file").replace(/[\\/]+/g, "_").replace(/[^A-Za-z0-9._-]+/g, "_") || "file";
  if (!used.has(base)) { used.add(base); return base; }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = 2;
  while (used.has(stem + "-" + n + ext)) n++;
  const out = stem + "-" + n + ext;
  used.add(out);
  return out;
}

/* Adds a file to the WASM virtual filesystem, returning the alias pandoc
 * should see. Binary files are wrapped as Blob (pandoc-wasm requires that). */
export function addFile(files, used, abs, suggestedName) {
  const alias = safeName(suggestedName || path.basename(abs), used);
  const ext = path.extname(abs).toLowerCase();
  if (IMAGE_EXT.has(ext) || !TEXT_EXT.has(ext)) files[alias] = toBlob(fs.readFileSync(abs));
  else files[alias] = readAsText(abs);
  return alias;
}

/* Finds local images referenced by markdown/HTML so pandoc-wasm (which has no
 * network/filesystem of its own) receives them as virtual files. */
export function collectReferencedFiles(text, cwd, addOne) {
  if (!text) return;
  const patterns = [
    /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    /<img[^>]+src=["']([^"']+)["']/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      let rel = m[1];
      if (!rel || /^(https?:|data:|mailto:|#|\/\/)/i.test(rel)) continue;
      try { rel = decodeURIComponent(rel); } catch (e) { /* keep */ }
      rel = rel.replace(/[?#].*$/, "");
      const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) addOne(abs, rel);
      } catch (e) { /* ignore */ }
    }
  }
}

function errorText(error) {
  if (!error) return "unknown error";
  const text = String(error.message || error);
  return text.length > 2000 ? text.slice(0, 2000) : text;
}

/* createPandocInstance is injected by the bundle entry point (pandoc-wasm's
 * core.js). Options: { wasmGzPath, version, wasmBytes }. */
export function createService(createPandocInstance, options) {
  const opts = options || {};
  const version = String(opts.version || "3.10");
  const wasmGzPath = opts.wasmGzPath || "";
  let instancePromise = null;
  let ready = false;
  let lastError = "";

  async function ensure() {
    if (!instancePromise) {
      instancePromise = (async () => {
        let bytes;
        if (opts.wasmBytes) bytes = opts.wasmBytes;
        else {
          if (!wasmGzPath || !fs.existsSync(wasmGzPath)) {
            throw new Error("pandoc.wasm.gz not found: " + (wasmGzPath || "(no path)"));
          }
          bytes = zlib.gunzipSync(fs.readFileSync(wasmGzPath));
        }
        const inst = await createPandocInstance(new Uint8Array(bytes));
        ready = true;
        return inst;
      })().catch((e) => {
        instancePromise = null;
        lastError = errorText(e);
        throw e;
      });
    }
    return instancePromise;
  }

  function versionText() {
    return "pandoc " + version + "\n" +
      "Features: +server +lua\n" +
      "Scripting engine: Lua 5.4\n" +
      "User data directory: (wasm sandbox)\n" +
      "Copyright (C) 2006-2026 John MacFarlane. WebAssembly build: pandoc-wasm.\n";
  }

  async function runCli(input) {
    const req = input || {};
    const argv = Array.isArray(req.argv) ? req.argv.slice() : shellSplit(String(req.argv || ""));
    const cwd = req.cwd || process.cwd();
    const result = { code: 0, stdout: "", stderr: "", version };
    if (!argv.length) { result.code = 1; result.stderr = "pandoc: no arguments"; return result; }
    /* A leading literal "pandoc" is tolerated (some plugins pass it). */
    if (isPandocCommand(argv[0])) argv.shift();
    const parsed = parseArgs(argv);

    if (parsed.showVersion) { result.stdout = versionText(); return result; }
    if (parsed.showHelp) {
      result.stdout = "pandoc [OPTIONS] [FILES]\n" +
        "OHSidian built-in pandoc (WebAssembly). Supports document conversion; " +
        "PDF output requires an external engine and is not available.\n";
      if (!parsed.inputs.length) return result;
    }
    if (parsed.pdfEngine || String(parsed.to).toLowerCase() === "pdf" ||
      String(parsed.output).toLowerCase().endsWith(".pdf")) {
      result.code = 1;
      result.stderr = "pandoc-wasm: PDF output is not supported (it needs LaTeX/Typst/xelatex, " +
        "which cannot run inside the WebAssembly sandbox). Export to .docx/.html/.epub, " +
        "or use OHSidian's built-in PDF export instead.\n";
      return result;
    }

    try {
      const inst = await ensure();
      if (parsed.listInputFormats) { result.stdout = (await inst.query({ query: "input-formats" })).join("\n") + "\n"; return result; }
      if (parsed.listOutputFormats) { result.stdout = (await inst.query({ query: "output-formats" })).join("\n") + "\n"; return result; }

      const files = {};
      const used = new Set();
      const toOpts = {};

      /* Inputs: one file is the common case; multiple text inputs are joined. */
      const stdinText = req.stdin === undefined || req.stdin === null ? "" : String(req.stdin);
      let stdinFromFiles = null;
      if (parsed.inputs.length) {
        const parts = [];
        for (const rawInput of parsed.inputs) {
          const abs = path.isAbsolute(rawInput) ? rawInput : path.resolve(cwd, rawInput);
          if (!fs.existsSync(abs)) {
            result.code = 1;
            result.stderr = "pandoc: " + rawInput + ": withBinaryFile: does not exist (No such file or directory)\n";
            return result;
          }
          const alias = addFile(files, used, abs, rawInput.replace(/^[./\\]+/, ""));
          const ext = path.extname(abs).toLowerCase();
          if (TEXT_EXT.has(ext)) {
            parts.push(files[alias]);
            collectReferencedFiles(files[alias], path.dirname(abs), (fileAbs, rel) => {
              addFile(files, used, fileAbs, rel);
            });
          } else {
            toOpts["input-files"] = (toOpts["input-files"] || []).concat([alias]);
            stdinFromFiles = null;
          }
        }
        if (parts.length) stdinFromFiles = parts.join("\n");
      }
      const stdin = stdinFromFiles !== null ? stdinFromFiles : stdinText;
      if (stdin) collectReferencedFiles(stdin, cwd, (fileAbs, rel) => addFile(files, used, fileAbs, rel));

      if (parsed.from) toOpts.from = parsed.from;
      if (parsed.to) toOpts.to = parsed.to;
      if (!toOpts.from && parsed.inputs.length) toOpts.from = inferFormatFromPath(parsed.inputs[0]) || "markdown";
      if (!toOpts.to && parsed.output) toOpts.to = inferFormatFromPath(parsed.output);
      if (!toOpts.from) toOpts.from = "markdown";
      if (!toOpts.to) toOpts.to = "html";
      if (parsed.standalone) toOpts.standalone = true;
      if (parsed.toc) toOpts["table-of-contents"] = true;
      if (parsed.numberSections) toOpts["number-sections"] = true;
      if (parsed.selfContained || parsed.embedResources) toOpts["embed-resources"] = true;
      if (parsed.variables && Object.keys(parsed.variables).length) toOpts.variables = parsed.variables;
      if (parsed.metadata && Object.keys(parsed.metadata).length) toOpts.metadata = parsed.metadata;

      const addResourceOption = (absFile, key) => {
        const alias = addFile(files, used, absFile, path.basename(absFile));
        toOpts[key] = alias;
      };
      if (parsed.template) {
        const abs = path.isAbsolute(parsed.template) ? parsed.template : path.resolve(cwd, parsed.template);
        if (fs.existsSync(abs)) addResourceOption(abs, "template");
        else if (parsed.template && files[parsed.template]) toOpts.template = parsed.template;
      }
      if (parsed.referenceDoc) {
        const abs = path.isAbsolute(parsed.referenceDoc) ? parsed.referenceDoc : path.resolve(cwd, parsed.referenceDoc);
        if (fs.existsSync(abs)) addResourceOption(abs, "reference-doc");
      }
      if (parsed.metadataFile) {
        const abs = path.isAbsolute(parsed.metadataFile) ? parsed.metadataFile : path.resolve(cwd, parsed.metadataFile);
        if (fs.existsSync(abs)) addResourceOption(abs, "metadata-file");
      }
      if (parsed.bibliography) {
        const abs = path.isAbsolute(parsed.bibliography) ? parsed.bibliography : path.resolve(cwd, parsed.bibliography);
        if (fs.existsSync(abs)) addResourceOption(abs, "bibliography");
      }
      if (parsed.csl) {
        const abs = path.isAbsolute(parsed.csl) ? parsed.csl : path.resolve(cwd, parsed.csl);
        if (fs.existsSync(abs)) addResourceOption(abs, "csl");
      }
      const filterAliases = [];
      for (const f of parsed.filters.concat(parsed.luaFilters)) {
        const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
        if (!fs.existsSync(abs)) {
          result.code = 1;
          result.stderr = "pandoc: " + f + ": withBinaryFile: does not exist\n";
          return result;
        }
        const alias = addFile(files, used, abs, path.basename(abs));
        if (path.extname(abs).toLowerCase() === ".lua") filterAliases.push(alias);
        else {
          result.code = 1;
          result.stderr = "pandoc-wasm: executable filters are not supported inside the WebAssembly sandbox " +
            "(" + f + "). Use a Lua filter instead.\n";
          return result;
        }
      }
      if (filterAliases.length) toOpts.filters = filterAliases;
      if (parsed.raw.length) {
        for (const [k, v] of parsed.raw) {
          if (toOpts[k] !== undefined) continue;
          toOpts[k] = v === undefined ? true : v;
        }
      }

      const outFmt = String(toOpts.to || "").toLowerCase();
      const outputSpec = parsed.output || "";
      let outputAlias = "";
      if (outputSpec) {
        const outExt = path.extname(outputSpec).toLowerCase() || FORMAT_TO_EXT[outFmt] || ".out";
        outputAlias = "out" + outExt;
        toOpts["output-file"] = outputAlias;
      }
      const conv = await inst.convert(toOpts, stdin || null, files);
      const stdoutMessages = conv.warnings && conv.warnings.length
        ? conv.warnings.map((w) => {
            if (w && typeof w.message === "string") return w.message;
            if (w && typeof w === "object") { try { return JSON.stringify(w); } catch (e) { return String(w); } }
            return String(w);
          }).join("\n") + "\n"
        : "";
      if (stdoutMessages) result.stderr = stdoutMessages;

      if (outputSpec) {
        const outAbs = path.isAbsolute(outputSpec) ? outputSpec : path.resolve(cwd, outputSpec);
        const blob = conv.files[outputAlias];
        if (blob === undefined) {
          result.code = 1;
          result.stderr += "pandoc-wasm: conversion produced no output file\n";
          return result;
        }
        const buf = blob instanceof Blob ? Buffer.from(await blob.arrayBuffer()) : Buffer.from(blob);
        fs.mkdirSync(path.dirname(outAbs), { recursive: true });
        fs.writeFileSync(outAbs, buf);
        if (!isBinaryOut(outFmt, outputSpec) && buf.length < 1048576) result.stdout = buf.toString("utf8");
      } else if (conv.stdout !== undefined && conv.stdout !== null && String(conv.stdout).length) {
        result.stdout = String(conv.stdout);
      } else {
        const only = Object.keys(conv.files).find((k) => k !== outputAlias && !Object.prototype.hasOwnProperty.call(files, k));
        if (only) {
          const blob = conv.files[only];
          if (isBinaryOut(outFmt, "")) {
            result.code = 1;
            result.stderr += "pandoc-wasm: binary output requires an explicit -o/--output file\n";
            return result;
          }
          result.stdout = blob instanceof Blob
            ? Buffer.from(await blob.arrayBuffer()).toString("utf8")
            : String(blob);
        }
      }
      if (parsed.extractMedia && conv.mediaFiles) {
        const mediaDir = path.isAbsolute(parsed.extractMedia)
          ? parsed.extractMedia : path.resolve(cwd, parsed.extractMedia);
        for (const [name, blob] of Object.entries(conv.mediaFiles)) {
          const target = path.join(mediaDir, name.replace(/^\.?[\\/]+/, ""));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const buf = blob instanceof Blob ? Buffer.from(await blob.arrayBuffer()) : Buffer.from(blob);
          fs.writeFileSync(target, buf);
        }
      }
      return result;
    } catch (e) {
      result.code = 1;
      result.stderr = "pandoc-wasm: " + errorText(e) + "\n";
      return result;
    }
  }

  async function query(q) {
    const inst = await ensure();
    return inst.query(q);
  }

  async function selfTest() {
    const checks = [];
    const run = async (name, fn) => {
      try {
        const r = await fn();
        checks.push({ name, ok: true, detail: r || "" });
      } catch (e) {
        checks.push({ name, ok: false, detail: errorText(e) });
      }
    };
    await run("version", async () => (await query({ query: "version" })).toString());
    await run("markdown -> html", async () => {
      const r = await runCli({ argv: ["-f", "markdown", "-t", "html"], stdin: "# self test\n" });
      if (r.code !== 0) throw new Error(r.stderr || "exit " + r.code);
      if (!/<h1[^>]*>self test<\/h1>/.test(r.stdout)) throw new Error("unexpected html output");
      return "ok (" + r.stdout.length + " chars)";
    });
    await run("markdown -> docx", async () => {
      const tmp = path.join(opts.tmpDir || process.cwd(), "ohsidian-pandoc-selftest.docx");
      const r = await runCli({ argv: ["-f", "markdown", "-t", "docx", "-o", tmp], stdin: "# self test\n" });
      if (r.code !== 0) throw new Error(r.stderr || "exit " + r.code);
      const buf = fs.readFileSync(tmp);
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error("output is not a docx zip");
      return buf.length + " bytes";
    });
    return { version, ready, checks };
  }

  return {
    version,
    wasmGzPath,
    get ready() { return ready; },
    get lastError() { return lastError; },
    versionText,
    ensure,
    query,
    runCli,
    selfTest,
    info() {
      let wasmBytes = 0;
      try { wasmBytes = wasmGzPath && fs.existsSync(wasmGzPath) ? fs.statSync(wasmGzPath).size : 0; } catch (e) { /* ignore */ }
      return { version, ready, lastError, wasmGzPath, wasmCompressedBytes: wasmBytes };
    },
  };
}
