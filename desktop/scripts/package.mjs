import {packager} from '@electron/packager';
import {mkdir,mkdtemp,copyFile,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=new URL('../',import.meta.url);
const stagingRoot=new URL('../../work/windows-package/',import.meta.url);
await mkdir(stagingRoot,{recursive:true});
const staging=pathToFileURL((await mkdtemp(fileURLToPath(new URL('release-',stagingRoot))))+'/');
const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
await writeFile(new URL('package.json',staging),JSON.stringify({name:pkg.name,productName:pkg.productName,version:pkg.version,main:'dist/main.cjs',license:'SEE LICENSE IN LICENSE'}));
for (const name of ['LICENSE','LICENSE.zh-CN.md','COMMERCIAL-LICENSING.md','COMMERCIAL-LICENSING.en.md']) {
  await copyFile(new URL(`../${name}`,root),new URL(name,staging));
}
const {cp}=await import('node:fs/promises');
await cp(new URL('dist/',root),new URL('dist/',staging),{recursive:true});
await cp(new URL('../third-party/',root),new URL('third-party/',staging),{recursive:true});
const buildId=new Date().toISOString().replace(/[:.]/g,'-');
const out=await packager({dir:fileURLToPath(staging),out:fileURLToPath(new URL(`../../releases/windows/${pkg.version}-${buildId}/`,import.meta.url)),name:'Live Voice',platform:'win32',arch:'x64',electronVersion:pkg.devDependencies.electron,electronZipDir:fileURLToPath(new URL(`../../work/toolchain/electron-${pkg.devDependencies.electron}/`,import.meta.url)),icon:fileURLToPath(new URL('icon.ico',root)),asar:true,overwrite:false,prune:true,appVersion:pkg.version,win32metadata:{CompanyName:'Live Voice',FileDescription:'Live Voice Windows',ProductName:'Live Voice'}});
console.log(out.join('\n'));
