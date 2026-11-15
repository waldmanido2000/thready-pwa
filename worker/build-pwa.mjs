import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const docs = new URL('../docs/',import.meta.url);
const source = new URL('./src/service-worker.js',import.meta.url);
const hash = createHash('sha256');
async function addFiles(folder) {
  const entries = await readdir(folder,{withFileTypes:true});
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name,'en'))) {
    if (entry.name === 'sw.js') continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''),folder);
    if (entry.isDirectory()) await addFiles(url);
    else {
      hash.update(fileURLToPath(url).slice(fileURLToPath(docs).length));
      hash.update(await readFile(url));
    }
  }
}
await addFiles(docs);
hash.update(await readFile(source));
await build({
  entryPoints:[fileURLToPath(source)],
  outfile:fileURLToPath(new URL('./sw.js',docs)),
  bundle:true,
  format:'iife',
  target:['safari16','chrome100','firefox102'],
  define:{__SHELL_VERSION__:JSON.stringify(hash.digest('hex').slice(0,16))}
});
