// @flow
import JSZip from 'jszip';

export * from './assets';
export * from './options';

export function nthIndex(str: string, pat: string, n: number): number {
  var length = str.length,
    i = -1;
  while (n-- && i++ < length) {
    i = str.indexOf(pat, i);
    if (i < 0) break;
  }
  return i;
}

export const ctrlKey: string = navigator.platform.includes('Mac')
  ? '⌘'
  : 'Ctrl';

function downloadBlob(name: string, blob: Blob) {
  const el = document.createElement('a');
  el.href = URL.createObjectURL(blob);
  el.download = name;
  el.click();
  setTimeout(() => URL.revokeObjectURL(el.href), 1000);
}
// function downloadBuffer(name: string, buf: Uint8Array, mime: string) {
//   const blob = new Blob([buf], {type: mime});
//   downloadBlob(name, blob);
// }

export async function downloadZIP(files: Map<string, {value: string, ...}>) {
  let zip = new JSZip();

  for (let [name, {value}] of files) {
    zip.file(name, value);
  }

  let blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 5,
    },
  });

  downloadBlob('repl.zip', blob);
}

export function linkSourceMapVisualization(
  bundle: string,
  sourcemap: string,
): string {
  let hash = Buffer.concat([
    Buffer.from(String(bundle.length)),
    Buffer.from([0]),
    Buffer.from(bundle),
    Buffer.from(String(sourcemap.length)),
    Buffer.from([0]),
    Buffer.from(sourcemap),
  ]);

  return (
    'https://evanw.github.io/source-map-visualization/#' +
    hash.toString('base64')
  );
}
