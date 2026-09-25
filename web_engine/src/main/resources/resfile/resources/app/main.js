let path = require('path');
let util = require('util');
let os = require('os');
let crypto = require('crypto');
let fs = require('fs');
let EventEmitter = require('events');
let electron = require('electron');
let remote = electron.remote;
try {
	remote = require('@electron/remote/main');
	electron.remote = remote;
} catch (e) {
	console.warn('[HMOS-REMOTE] @electron/remote/main is unavailable, falling back to electron.remote', e);
	if (!remote) {
		remote = {
			initialize: () => {},
			enable: () => {}
		};
		electron.remote = remote;
	}
}
let {app, protocol} = electron;

if (remote && typeof remote.initialize === 'function') {
	remote.initialize();
}
// Explicitly enable @electron/remote for every webContents created later, so
// renderer-side remote calls (and the touch-mode bridge in the patched asar)
// keep working regardless of the engine's default webPreferences.
if (remote && typeof remote.enable === 'function') {
	app.on('web-contents-created', (event, webContents) => {
		try {
			remote.enable(webContents);
		} catch (e) {
			console.warn('[HMOS-REMOTE] enable(webContents) failed', e);
		}
	});
}

protocol.registerSchemesAsPrivileged([
	{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true}}
]);

let updateEvents = new EventEmitter();

let insider = false;
let disable = false;
let silence = false;
updateEvents.on('insider', (arg) => {
	insider = arg;
});
updateEvents.on('disable', (arg) => {
	disable = arg;
});
updateEvents.on('silence', (arg) => {
	silence = arg;
});

let APP_PATH = (() => {
	let path = app.getAppPath();
	let asar_index = path.indexOf('app.asar');
	if (asar_index >= 0) {
		return path.slice(0, asar_index);
	}
	return path;
})();

let dataPath = app.getPath('userData');

function itemExists(filePath) {
	try {
		fs.accessSync(filePath);
		return true;
	} catch (e) {
		return false;
	}
}

function normalizeForPrefix(filePath) {
	return path.resolve(filePath).replace(/\\/g, '/');
}

function getVaultTrashDir(targetPath) {
	try {
		let obsidianConfigPath = path.join(dataPath, 'obsidian.json');
		if (fs.existsSync(obsidianConfigPath)) {
			let obsidianConfig = JSON.parse(fs.readFileSync(obsidianConfigPath, 'utf8'));
			let vaults = obsidianConfig && obsidianConfig.vaults;
			if (vaults) {
				let normalizedTarget = normalizeForPrefix(targetPath);
				let matchedVaultPath = null;
				for (let id of Object.keys(vaults)) {
					let vaultPath = vaults[id] && vaults[id].path;
					if (!vaultPath || !fs.existsSync(vaultPath)) continue;
					let normalizedVault = normalizeForPrefix(vaultPath);
					if (normalizedTarget === normalizedVault || normalizedTarget.startsWith(normalizedVault + '/')) {
						if (!matchedVaultPath || normalizedVault.length > normalizeForPrefix(matchedVaultPath).length) {
							matchedVaultPath = vaultPath;
						}
					}
				}
				if (matchedVaultPath) return path.join(matchedVaultPath, '.trash');
			}
		}
		return getVaultTrashDirByFilesystem(targetPath);
	} catch (e) {
		console.error('[HMOS-TRASH] failed to resolve vault trash dir', e);
		return getVaultTrashDirByFilesystem(targetPath);
	}
}

function getVaultTrashDirByFilesystem(targetPath) {
	try {
		let dir = fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
		while (dir && path.dirname(dir) !== dir) {
			if (fs.existsSync(path.join(dir, '.obsidian'))) {
				return path.join(dir, '.trash');
			}
			dir = path.dirname(dir);
		}
	} catch (e) {
	}
	return path.join(path.dirname(targetPath), '.trash');
}

function moveToVaultTrash(targetPath) {
	let trashDir = getVaultTrashDir(targetPath);
	if (!trashDir) return false;
	fs.mkdirSync(trashDir, {recursive: true});
	let parsed = path.parse(targetPath);
	let targetName = parsed.base;
	let trashPath = path.join(trashDir, targetName);
	if (fs.existsSync(trashPath)) {
		trashPath = path.join(trashDir, parsed.name + '-' + Date.now() + parsed.ext);
	}
	fs.renameSync(targetPath, trashPath);
	console.log('[HMOS-TRASH] moved to vault trash fallback', targetPath, '->', trashPath);
	return true;
}

async function waitForMissing(filePath, timeoutMs) {
	let deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!itemExists(filePath)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return !itemExists(filePath);
}

function installHarmonyTrashCompat() {
	if (!electron.shell || typeof electron.shell.trashItem !== 'function') return;
	let nativeTrashItem = electron.shell.trashItem.bind(electron.shell);
	electron.shell.trashItem = async function(targetPath) {
		let existedBefore = itemExists(targetPath);
		// Fast path (instant): vault files move into the vault's .trash by
		// rename. The native shell.trashItem on this port reports success
		// without actually removing the file, which stalled every delete for
		// the 3s wait before the same rename ran as a fallback.
		if (existedBefore) {
			try {
				if (moveToVaultTrash(targetPath)) {
					console.log('[HMOS-TRASH] moved to vault trash', targetPath);
					return;
				}
			} catch (trashErr) {
				console.error('[HMOS-TRASH] vault trash failed', trashErr);
			}
			// The rename can legitimately fail for paths outside any vault
			// (cross-device move): fall through to the system trash.
		}
		try {
			let result = await nativeTrashItem(targetPath);
			if (!existedBefore || await waitForMissing(targetPath, 1000)) {
				console.log('[HMOS-TRASH] native trash succeeded', targetPath);
				return result;
			}
			throw new Error('HarmonyOS native trash returned but the file still exists');
		} catch (e) {
			console.error('[HMOS-TRASH] native trash failed', e);
			if (existedBefore && itemExists(targetPath)) {
				try {
					if (moveToVaultTrash(targetPath)) {
						return;
					}
				} catch (trashErr) {
					console.error('[HMOS-TRASH] vault trash fallback failed', trashErr);
				}
			}
			throw e;
		}
	};
}

installHarmonyTrashCompat();

async function runHarmonyTrashSelfTest() {
	let obsidianConfigPath = path.join(dataPath, 'obsidian.json');
	let originalConfig = null;
	try {
		await app.whenReady();
		let testRoot = path.join(dataPath, 'harmony-trash-self-test');
		let testVault = path.join(testRoot, 'vault');
		fs.mkdirSync(testVault, {recursive: true});
		fs.mkdirSync(path.join(testVault, '.obsidian'), {recursive: true});
		if (fs.existsSync(obsidianConfigPath)) {
			originalConfig = fs.readFileSync(obsidianConfigPath, 'utf8');
		}
		let config = originalConfig ? JSON.parse(originalConfig) : {};
		config.vaults = config.vaults || {};
		config.vaults['hmos-trash-self-test'] = {path: testVault, ts: Date.now()};
		fs.writeFileSync(obsidianConfigPath, JSON.stringify(config, null, 2), 'utf8');
		let testFile = path.join(testVault, 'delete-me-' + Date.now() + '.md');
		fs.writeFileSync(testFile, 'HarmonyOS trash self test', 'utf8');
		await electron.shell.trashItem(testFile);
		let removed = await waitForMissing(testFile, 3000);
		console.log('[HMOS-TRASH-TEST]', removed ? 'pass' : 'fail', testFile);
	} catch (e) {
		console.error('[HMOS-TRASH-TEST] fail', e);
	} finally {
		try {
			if (originalConfig === null) {
				fs.rmSync(obsidianConfigPath, {force: true});
			} else {
				fs.writeFileSync(obsidianConfigPath, originalConfig, 'utf8');
			}
			fs.rmSync(path.join(dataPath, 'harmony-trash-self-test'), {recursive: true, force: true});
		} catch (e) {
			console.error('[HMOS-TRASH-TEST] cleanup failed', e);
		}
	}
}

if (fs.existsSync(path.join(APP_PATH, 'harmonyos-trash-test.enabled'))) {
	runHarmonyTrashSelfTest();
}

function pad(number) {
	if (number < 10) {
		return '0' + number;
	}
	return number;
}

function stamp() {
	let d = new Date();
	return d.getUTCFullYear() +
		'-' + pad(d.getUTCMonth() + 1) +
		'-' + pad(d.getUTCDate()) +
		' ' + pad(d.getUTCHours()) +
		':' + pad(d.getUTCMinutes()) +
		':' + pad(d.getUTCSeconds());
}

function logger(logfile) {
	let fileout = fs.openSync(logfile, 'a');
	let stdout = process.stdout;

	stdout.on('error', function(e) {
		// `write` failed. Do nothing...
	});

	let fn = function () {
		let data = stamp() + ' ' + util.format.apply(null, arguments) + os.EOL;

		try {
			fs.writeSync(fileout, data);
			// Don't output to stdout if the app requests silence mode (to avoid polluting CLI outputs)
			if (!silence) stdout.write(data);
		}
		catch (e) {
			// Failed to write to log
		}
	};

	fn.end = function () {
		fs.closeSync(fileout);
	};

	return fn;
}

let log;
try {
	log = logger(path.join(dataPath, 'obsidian.log'));
} catch (e) {
	log = function () {};
	log.end = function () {};
}

let idFile = path.join(dataPath, 'id');
let id;
try {
	if (fs.existsSync(idFile)) {
		id = fs.readFileSync(idFile, 'utf8');
	}
} catch (e) {
}
try {
	if (!id || id.length < 16) {
		id = crypto.randomBytes(16).toString('hex');
		fs.writeFileSync(idFile, id, 'utf8');
	}
} catch (e) {
}

// Auto-update is disabled on this port; Obsidian's manual "check for update"
// action lands here and must still emit check-end so its UI does not hang.
let queueUpdate = (manual) => {
	log('HarmonyOS port: desktop auto-update is disabled');
	updateEvents.emit('check-end');
};

// The desktop updater (update/runUpdate/downloadUpdate) was removed: it is
// disabled on this port and its telemetry/verify logic is dead code here.
// Obsidian updates ship as new HAPs built by scripts/update-obsidian.mjs.

function loadApp(asarPath) {
	// Execute asar content
	let main = path.join(asarPath, 'main.js');

	let fn;
	try {
		fn = require(main);
	} catch (e) {
		log('Failed to require app package', asarPath);
		console.error(e);
		return false;
	}

	if (fn) {
		fn(asarPath, updateEvents);
		return true;
	}
	return false;
}

// Source: https://github.com/electron/electron/blob/19954126e08c67022b89a886cadb10471ac853ae/lib/browser/init.ts#L20
process.on('uncaughtException', function (error) {
	// Don't emit errors for updater
	if (error.message && error.message.indexOf('net::ERR') !== -1) {
		console.error('Suppressed network error:', error && error.stack);
		return;
	}

	// Accessing an already-destroyed BrowserWindow/WebContents is a benign
	// shutdown race (e.g. an IPC handler running while its window closes).
	// Log it and keep the app alive instead of showing the error dialog.
	if (error.message && error.message.indexOf('Object has been destroyed') !== -1) {
		console.error('Suppressed destroyed-object error:', error && error.stack);
		return;
	}

	console.error('Uncaught Exception', error);

	// Show error in GUI.
	// We can't import { dialog } at the top of this file as this file is
	// responsible for setting up the require hook for the "electron" module
	// so we import it inside the handler down here
	import('electron')
		.then(({dialog}) => {
			const stack = error.stack ? error.stack : `${error.name}: ${error.message}`;
			const message = 'Uncaught Exception:\n' + stack;
			dialog.showErrorBox('A JavaScript error occurred in the main process', message);
		});
});

// Actual startup routine
// Load the Obsidian app bundled with this HAP. Side-loading obsidian-*.asar
// from userData was removed for security: those files cannot be verified
// against the pinned distribution signature (which covers the compressed
// archive), so anything with userData write access could otherwise gain
// persistent main-process code execution. Use scripts/update-obsidian.mjs
// to rebuild the bundled asar instead.
let asarPath = path.join(APP_PATH, 'obsidian.asar');
let success = loadApp(asarPath);
if (success) {
	log('Loaded main app package', asarPath);
} else {
	log('Failed to load app package.');
}

queueUpdate();
updateEvents.on('check', () => queueUpdate(true));
