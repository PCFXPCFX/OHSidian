// Proper single-pass scanner: handles strings/chars/template literals/comments
// in one pass (no regex pre-strip), so 'fd://' style strings don't break it.
const fs = require('fs');
const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const stack = [];
  let state = 'code'; // code | line | block | str | chr | tpl
  let tplDepth = []; // track ${ inside templates
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i++; continue; }
      if (c === '/' && n === '*') { state = 'block'; i++; continue; }
      if (c === "'") { state = 'str'; continue; }
      if (c === '"') { state = 'chr'; continue; }
      if (c === '`') { state = 'tpl'; continue; }
      if (c === '{' || c === '(' || c === '[') stack.push(c);
      if (c === '}' || c === ')' || c === ']') {
        const open = stack.pop();
        const want = c === '}' ? '{' : c === ')' ? '(' : '[';
        if (open !== want) { stack.push('MISMATCH@' + i); break; }
      }
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
    } else if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i++; }
    } else if (state === 'str' || state === 'chr') {
      if (c === '\\') { i++; continue; }
      if ((state === 'str' && c === "'") || (state === 'chr' && c === '"')) state = 'code';
    } else if (state === 'tpl') {
      if (c === '\\') { i++; continue; }
      if (c === '`') state = 'code';
    }
  }
  const ok = stack.length === 0 && state !== 'block';
  if (!ok) bad++;
  console.log(`${ok ? 'OK ' : 'BAD'} ${f} state=${state} unclosed=[${stack.slice(-3).join(',')}]`);
}
process.exit(bad ? 1 : 0);
