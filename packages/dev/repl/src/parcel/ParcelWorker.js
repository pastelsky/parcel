// @flow
import type {Diagnostic} from '@parcel/diagnostic';
import type {FSList, CodeMirrorDiagnostic, REPLOptions} from '../utils';
import type {MemoryFS} from '@parcel/fs';

import {expose, proxy} from 'comlink';
import Parcel, {createWorkerFarm} from '@parcel/core';
// import {MemoryFS} from '@parcel/fs';
// $FlowFixMe
import {ExtendedMemoryFS} from '@parcel/fs';
import {makeDeferredWithPromise} from '@parcel/utils';
// import SimplePackageInstaller from './SimplePackageInstaller';
// import {NodePackageManager} from '@parcel/package-manager';
import configRepl from '@parcel/config-repl';
import {generatePackageJson, nthIndex} from '../utils/';
// import {IDBCache} from '@parcel/cache';
// import {RemoteCache} from '@parcel/cache';
import path from 'path';
import {yarnInstall} from './yarn.js';
import {BrowserPackageManager} from './BrowserPackageManager.js';

export type BundleOutput =
  | {|
      type: 'success',
      bundles: Array<{|
        name: string,
        content: string,
        size: number,
        time: number,
      |}>,
      buildTime: number,
      graphs: ?Array<{|name: string, content: string|}>,
      sourcemaps: ?Map<string, string>,
    |}
  | {|
      type: 'failure',
      error?: Error,
      diagnostics: Map<string, Array<CodeMirrorDiagnostic>>,
    |};

let workerFarm;
let fs: MemoryFS;
function startWorkerFarm(numWorkers: ?number) {
  // $FlowFixMe
  if (!workerFarm || workerFarm.maxConcurrentWorkers != numWorkers) {
    workerFarm?.end();
    // $FlowFixMe
    workerFarm = createWorkerFarm(
      numWorkers != null ? {maxConcurrentWorkers: numWorkers} : {},
    );
    fs = new ExtendedMemoryFS(workerFarm);
    fs.chdir('/app');

    // $FlowFixMe
    globalThis.fs = fs;
    globalThis.workerFarm = workerFarm;
  }
}

let swFSPromise, resolveSWFSPromise;
function resetSWPromise() {
  ({
    promise: swFSPromise,
    deferred: {resolve: resolveSWFSPromise},
  } = makeDeferredWithPromise());
}

let sw: MessagePort;
global.PARCEL_SERVICE_WORKER = async (type, data) => {
  await sendMsg(sw, type, data);
  if (type === 'setFS') {
    resolveSWFSPromise();
  }
};
global.PARCEL_SERVICE_WORKER_REGISTER = (type, cb) => {
  // $FlowFixMe[incompatible-type]
  let wrapper: EventHandler = async (evt: ExtendableMessageEvent) => {
    if (evt.data.type === type) {
      let response = await cb(evt.data.data);
      sw.postMessage({
        type,
        id: evt.data.id,
        data: response,
      });
    }
  };

  sw.addEventListener('message', wrapper);
  return () => sw.removeEventListener('message', wrapper);
};

expose({
  bundle,
  watch,
  ready: numWorkers =>
    new Promise(res => {
      startWorkerFarm(numWorkers);
      if (workerFarm.readyWorkers === workerFarm.options.maxConcurrentWorkers) {
        res(true);
      } else {
        workerFarm.once('ready', () => res(true));
      }
    }),
  waitForFS: () => proxy(swFSPromise),
  setServiceWorker: v => {
    sw = v;
    sw.start();
  },
});

const PathUtils = {
  APP_DIR: '/app',
  DIST_DIR: '/app/dist',
  CACHE_DIR: '/.parcel-cache',
  fromAssetPath(str) {
    return path.join('/app', str);
  },
  toAssetPath(str) {
    return str.startsWith('/app/') ? str.slice(5) : str;
  },
};

function removeTrailingNewline(text: string): string {
  if (text[text.length - 1] === '\n') {
    return text.slice(0, -1);
  } else {
    return text;
  }
}
async function convertDiagnostics(inputFS, diagnostics: Array<Diagnostic>) {
  let parsedDiagnostics = new Map<string, Array<CodeMirrorDiagnostic>>();
  for (let diagnostic of diagnostics) {
    let {filePath = '', codeFrames, origin} = diagnostic;
    let list = parsedDiagnostics.get(PathUtils.toAssetPath(filePath));
    if (!list) {
      list = [];
      parsedDiagnostics.set(PathUtils.toAssetPath(filePath), list);
    }

    if (codeFrames) {
      for (let codeFrame of codeFrames) {
        for (let {start, end, message} of codeFrame.codeHighlights) {
          let code =
            codeFrame.code ??
            (await inputFS.readFile(
              path.resolve(PathUtils.APP_DIR, codeFrame.filePath ?? filePath),
              'utf8',
            ));

          let from = nthIndex(code, '\n', start.line - 1) + start.column;
          let to = nthIndex(code, '\n', end.line - 1) + end.column;

          list.push({
            from,
            to,
            severity: 'error',
            source: origin || 'info',
            message: message || diagnostic.message,
            stack: diagnostic.stack,
          });
        }
      }
    } else {
      list.push({
        from: 0,
        to: 0,
        severity: 'error',
        source: origin || 'info',
        message: diagnostic.message,
        stack: diagnostic.stack,
      });
    }
  }
  return parsedDiagnostics;
}

async function setup(assets, options) {
  if (!(await fs.exists('/.parcelrc'))) {
    await fs.writeFile('/.parcelrc', JSON.stringify(configRepl, null, 2));
  }
  // TODO for NodeResolver
  if (!(await fs.exists('/_empty.js'))) {
    await fs.writeFile('/_empty.js', '');
  }

  let graphs = options.renderGraphs ? [] : null;
  if (graphs && options.renderGraphs) {
    // $FlowFixMe
    globalThis.PARCEL_DUMP_GRAPHVIZ = (name, content) =>
      graphs.push({name, content});
    globalThis.PARCEL_DUMP_GRAPHVIZ.mode = options.renderGraphs;
  }

  // TODO only create new instance if options/entries changed
  let entries = assets
    .filter(([, data]) => data.isEntry)
    .map(([name]) => PathUtils.fromAssetPath(name));
  const bundler = new Parcel({
    entries,
    // https://github.com/parcel-bundler/parcel/pull/4290
    shouldDisableCache: false,
    cacheDir: PathUtils.CACHE_DIR,
    mode: options.mode,
    env: {
      NODE_ENV: options.mode,
    },
    hmrOptions: options.hmr ? {} : null,
    logLevel: 'verbose',
    shouldPatchConsole: false,
    workerFarm,
    defaultConfig: '/.parcelrc',
    inputFS: fs,
    outputFS: fs,
    // cache: new IDBCache(),
    // cache: new RemoteCache(fs, '/.parcel-cache', 'http://localhost:2392'),
    defaultTargetOptions: {
      distDir: PathUtils.DIST_DIR,
      publicUrl: options.publicUrl || undefined,
      shouldOptimize: options.minify,
      shouldScopeHoist: options.scopeHoist,
      sourceMaps: options.sourceMaps,
    },
    packageManager: new BrowserPackageManager(fs, '/'),
    // packageManager: new NodePackageManager(
    //   memFS,
    //   new SimplePackageInstaller(memFS),
    // ),
  });

  return {bundler, graphs};
}

async function collectResult(output, graphs, fs) {
  if (output.success) {
    let bundleContents = [];
    let sourcemaps = new Map();
    for (let {filePath, size, time} of output.success.bundles) {
      let name = PathUtils.toAssetPath(filePath);
      let content = removeTrailingNewline(await fs.readFile(filePath, 'utf8'));
      bundleContents.push({
        name,
        content,
        size,
        time,
      });
      if (content.length < 5000000 && (await fs.exists(filePath + '.map'))) {
        sourcemaps.set(name, await fs.readFile(filePath + '.map', 'utf8'));
      }
    }

    bundleContents.sort(({name: a}, {name: b}) => a.localeCompare(b));

    return {
      type: 'success',
      bundles: bundleContents,
      buildTime: output.success.buildTime,
      graphs,
      sourcemaps,
    };
  } else {
    return {
      type: 'failure',
      diagnostics: await convertDiagnostics(fs, output.failure),
    };
  }
}

async function syncAssetsToFS(assets: FSList, options: REPLOptions) {
  await fs.mkdirp('/app');

  let filesToKeep = new Set([
    '/app/.yarn',
    '/app/node_modules',
    '/app/yarn.lock',
    '/app/package.json',
    ...assets.map(([name]) => PathUtils.fromAssetPath(name)),
  ]);

  for (let [name, {value}] of assets) {
    if (name === '/package.json') continue;
    let p = PathUtils.fromAssetPath(name);
    await fs.mkdirp(path.dirname(p));
    if (!(await fs.exists(p)) || (await fs.readFile(p, 'utf8')) !== value) {
      await fs.writeFile(p, value);
    }
  }

  let oldPackageJson = (await fs.exists('/app/package.json'))
    ? await fs.readFile('/app/package.json', 'utf8')
    : null;
  let newPackageJson =
    assets.find(([name]) => name === '/package.json')?.[1].value ??
    generatePackageJson(options);

  if (!oldPackageJson || oldPackageJson.trim() !== newPackageJson.trim()) {
    await fs.writeFile('/app/package.json', newPackageJson);
  }

  for (let f of await fs.readdir('/app')) {
    f = '/app/' + f;
    if (filesToKeep.has(f) || [...filesToKeep].some(k => k.startsWith(f))) {
      continue;
    }
    await fs.rimraf(f);
  }
}

async function bundle(
  assets: FSList,
  options: REPLOptions,
  progress: string => void,
): Promise<BundleOutput> {
  const resultFromReporter = new Promise(res => {
    // $FlowFixMe
    globalThis.PARCEL_JSON_LOGGER_STDOUT = d => {
      switch (d.type) {
        case 'buildSuccess':
          res({success: d});
          break;
        case 'buildFailure': {
          res({failure: d.message});
          break;
        }
      }
    };
    globalThis.PARCEL_JSON_LOGGER_STDERR = globalThis.PARCEL_JSON_LOGGER_STDOUT;
  });
  const {bundler, graphs} = await setup(assets, {...options, hmr: false});

  resetSWPromise();
  await syncAssetsToFS(assets, options);

  await yarnInstall(options, fs, PathUtils.APP_DIR, v => {
    if (v.data.includes('Resolution step')) {
      progress('Yarn: Resolving');
    } else if (v.data.includes('Fetch step')) {
      progress('Yarn: Fetching');
    } else if (v.data.includes('Link step')) {
      progress('Yarn: Linking');
    }
  });

  progress('Bundling');

  try {
    let error;
    try {
      await bundler.run();
    } catch (e) {
      console.log(e);
      error = e;
    }

    let result = await Promise.race([
      resultFromReporter,
      new Promise(res => setTimeout(() => res(null), 100)),
    ]);
    if (result) {
      return await collectResult(result, graphs, fs);
    } else {
      throw error;
    }
  } catch (error) {
    console.error(error);
    return {
      type: 'failure',
      error: error,
      diagnostics:
        error.diagnostics && (await convertDiagnostics(fs, error.diagnostics)),
    };
  }
}

async function watch(
  assets: FSList,
  options: REPLOptions,
  onBuild: BundleOutput => void,
  progress: (?string) => void,
): Promise<{|
  unsubscribe: () => Promise<mixed>,
  writeAssets: FSList => Promise<mixed>,
|}> {
  const reporterEvents = new EventTarget();
  // $FlowFixMe
  globalThis.PARCEL_JSON_LOGGER_STDOUT = d => {
    switch (d.type) {
      case 'buildSuccess':
        Promise.resolve().then(() =>
          reporterEvents.dispatchEvent(
            new CustomEvent('build', {detail: {success: d}}),
          ),
        );
        break;
      case 'buildFailure': {
        Promise.resolve().then(() =>
          reporterEvents.dispatchEvent(
            new CustomEvent('build', {detail: {failure: d.message}}),
          ),
        );
        break;
      }
    }
  };
  globalThis.PARCEL_JSON_LOGGER_STDERR = globalThis.PARCEL_JSON_LOGGER_STDOUT;

  let {bundler, graphs} = await setup(assets, options);

  resetSWPromise();
  await syncAssetsToFS(assets, options);

  await yarnInstall(options, fs, PathUtils.APP_DIR, v => {
    if (v.data.includes('Resolution step')) {
      progress('Yarn: Resolving');
    } else if (v.data.includes('Fetch step')) {
      progress('Yarn: Fetching');
    } else if (v.data.includes('Link step')) {
      progress('Yarn: Linking');
    }
  });

  progress('building');

  reporterEvents.addEventListener('build', async (e: Event) => {
    // $FlowFixMe
    let {detail} = e;
    let result = await collectResult(detail, graphs, fs);
    onBuild(result);
  });

  return proxy({
    unsubscribe: (await bundler.watch()).unsubscribe,
    writeAssets: assets => {
      resetSWPromise();
      syncAssetsToFS(assets, options);
    },
  });
}

function uuidv4() {
  return (String(1e7) + -1e3 + -4e3 + -8e3 + -1e11).replace(
    /[018]/g,
    // $FlowFixMe
    (c: number) =>
      (
        c ^
        // $FlowFixMe
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
      ).toString(16),
  );
}

function sendMsg(target, type, data, transfer) {
  let id = uuidv4();
  return new Promise(res => {
    let handler = (evt: MessageEvent) => {
      // $FlowFixMe
      if (evt.data.id === id) {
        target.removeEventListener('message', handler);
        // $FlowFixMe
        res(evt.data.data);
      }
    };
    target.addEventListener('message', handler);
    target.postMessage({type, data, id}, transfer);
  });
}

class EventTarget {
  listeners: {|[string]: Array<Function>|};
  constructor() {
    this.listeners = {};
  }

  addEventListener(type, callback) {
    if (!(type in this.listeners)) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(callback);
  }

  removeEventListener(type, callback) {
    if (!(type in this.listeners)) {
      return;
    }
    var stack = this.listeners[type];
    for (var i = 0, l = stack.length; i < l; i++) {
      if (stack[i] === callback) {
        stack.splice(i, 1);
        return;
      }
    }
  }

  dispatchEvent(event) {
    if (!(event.type in this.listeners)) {
      return true;
    }
    var stack = this.listeners[event.type].slice();

    for (var i = 0, l = stack.length; i < l; i++) {
      stack[i].call(this, event);
    }
    return !event.defaultPrevented;
  }
}
