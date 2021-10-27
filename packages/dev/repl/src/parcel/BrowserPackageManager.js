// @flow
import type {FilePath, DependencySpecifier, SemverRange} from '@parcel/types';
import type {FileSystem} from '@parcel/fs';
import type {
  PackageManager,
  Invalidations,
  ResolveResult,
} from '@parcel/package-manager';
import {registerSerializableClass} from '@parcel/core';
// $FlowFixMe[untyped-import]
import packageJson from '../../package.json';

import path from 'path';
// eslint-disable-next-line monorepo/no-internal-import
import {NodeResolver} from '@parcel/package-manager/src/NodeResolver.js';

import bundlerDefault from '@parcel/bundler-default';
import compressorRaw from '@parcel/compressor-raw';
import namerDefault from '@parcel/namer-default';
import optimizerTerser from '@parcel/optimizer-terser';
import packagerCss from '@parcel/packager-css';
import packagerHtml from '@parcel/packager-html';
import packagerJs from '@parcel/packager-js';
import packagerRaw from '@parcel/packager-raw';
import reporterJson from '@parcel/reporter-json';
import reporterServer from '@parcel/reporter-dev-server-sw';
import resolverDefault from '@parcel/resolver-default';
import resolverREPLRuntimes from '@parcel/resolver-repl-runtimes';
import runtimeHMRSSE from '@parcel/runtime-browser-hmr-sse';
import runtimeJs from '@parcel/runtime-js';
import runtimeReactRefresh from '@parcel/runtime-react-refresh';
import transformerBabel from '@parcel/transformer-babel';
import transformerCss from '@parcel/transformer-css';
import transformerHtml from '@parcel/transformer-html';
import transformerInlineString from '@parcel/transformer-inline-string';
import transformerJs from '@parcel/transformer-js';
import transformerJson from '@parcel/transformer-json';
import transformerPostcss from '@parcel/transformer-postcss';
import transformerPosthtml from '@parcel/transformer-posthtml';
import transformerRaw from '@parcel/transformer-raw';
import transformerReactRefreshWrap from '@parcel/transformer-react-refresh-wrap';

export const BUILTINS = {
  '@parcel/bundler-default': bundlerDefault,
  '@parcel/compressor-raw': compressorRaw,
  '@parcel/namer-default': namerDefault,
  '@parcel/optimizer-terser': optimizerTerser,
  '@parcel/packager-css': packagerCss,
  '@parcel/packager-html': packagerHtml,
  '@parcel/packager-js': packagerJs,
  '@parcel/packager-raw': packagerRaw,
  '@parcel/reporter-dev-server-sw': reporterServer,
  '@parcel/reporter-json': reporterJson,
  '@parcel/resolver-default': resolverDefault,
  '@parcel/resolver-repl-runtimes': resolverREPLRuntimes,
  '@parcel/runtime-browser-hmr-sse': runtimeHMRSSE,
  '@parcel/runtime-js': runtimeJs,
  '@parcel/runtime-react-refresh': runtimeReactRefresh,
  '@parcel/transformer-babel': transformerBabel,
  '@parcel/transformer-css': transformerCss,
  '@parcel/transformer-html': transformerHtml,
  '@parcel/transformer-inline-string': transformerInlineString,
  '@parcel/transformer-js': transformerJs,
  '@parcel/transformer-json': transformerJson,
  '@parcel/transformer-postcss': transformerPostcss,
  '@parcel/transformer-posthtml': transformerPosthtml,
  '@parcel/transformer-raw': transformerRaw,
  '@parcel/transformer-react-refresh-wrap': transformerReactRefreshWrap,
};

export class BrowserPackageManager implements PackageManager {
  resolver: NodeResolver;
  fs: FileSystem;
  projectRoot: FilePath;
  cache: Map<DependencySpecifier, ResolveResult> = new Map();

  constructor(fs: FileSystem, projectRoot: FilePath) {
    this.fs = fs;
    this.projectRoot = projectRoot;
    this.resolver = new NodeResolver(fs, projectRoot);
  }

  static deserialize(opts: any): BrowserPackageManager {
    return new BrowserPackageManager(opts.fs, opts.projectRoot);
  }

  serialize(): {|
    $$raw: boolean,
    fs: FileSystem,
    projectRoot: FilePath,
  |} {
    return {
      $$raw: false,
      fs: this.fs,
      projectRoot: this.projectRoot,
    };
  }

  async require(
    name: DependencySpecifier,
    from: FilePath,
    opts: ?{|
      range?: ?SemverRange,
      shouldAutoInstall?: boolean,
      saveDev?: boolean,
    |},
  ): Promise<any> {
    let {resolved} = await this.resolve(name, from, opts);

    // $FlowFixMe
    if (resolved in BUILTINS) {
      return BUILTINS[resolved];
    }

    throw new Error(`Cannot require '${resolved}' in the browser`);
  }

  async resolve(
    name: DependencySpecifier,
    // eslint-disable-next-line no-unused-vars
    from: FilePath,
    // eslint-disable-next-line no-unused-vars
    options?: ?{|
      range?: ?SemverRange,
      shouldAutoInstall?: boolean,
      saveDev?: boolean,
    |},
  ): Promise<ResolveResult> {
    if (name.startsWith('@parcel/') && name !== '@parcel/watcher') {
      return Promise.resolve({
        resolved: name,
        pkg: {
          name: name,
          version: '2.0.0',
          engines: {
            parcel: '2.0.0',
          },
        },
        invalidateOnFileChange: new Set(),
        invalidateOnFileCreate: [],
      });
    }

    let basedir = path.dirname(from);
    let key = basedir + ':' + name;
    let resolved = this.cache.get(key);
    if (!resolved) {
      resolved = await this.resolver.resolve(name, from);
      this.cache.set(key, resolved);
    }
    return resolved;
  }

  getInvalidations(): Invalidations {
    return {invalidateOnFileCreate: [], invalidateOnFileChange: new Set()};
  }
  invalidate(): void {}
}

registerSerializableClass(
  `${packageJson.version}:BrowserPackageManager`,
  BrowserPackageManager,
);
