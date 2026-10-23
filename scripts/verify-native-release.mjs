import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const release=path.resolve(process.argv[2]),checks=path.resolve(process.argv[3]);
const pkg=JSON.parse(await fs.readFile('package.json','utf8')),version=pkg.build.buildVersion;
const read=async name=>JSON.parse(await fs.readFile(path.join(checks,name),'utf8'));
const reports={
 native:await read('release-packaged-native-final/verification.json'),
 view:await read('release-packaged-view/verification.json'),
 largeModel:await read('release-installer-million/verification.json'),
 input:await read('release-installer-input/verification.json'),
 defaultFolder:await read('release-default-folder/verification.json'),
 bake:await read('release-bake-check/verification.json'),
 bakedPlayer:await read('release-baked-player/verification.json'),
 bakedFolder:await read('release-bake-check/baked-folder-verification.json'),
 unrealFolder:await read('release-native-folder/verification.json'),
};
for(const [name,report] of Object.entries(reports))assert.equal(report.success,true,name+' must pass');
assert.equal(reports.native.hosting,'actual-unreal-library');assert.equal(reports.largeModel.hosting,'actual-unreal-library');
assert.equal(reports.largeModel.fixtureTriangles,reports.largeModel.renderedTriangles);assert.equal(reports.largeModel.restoredBinaryUploads,0);
assert.ok(reports.input.nativeSelection);assert.ok(reports.input.nativePlacement);assert.equal(reports.input.after.columns,3);
assert.ok(reports.input.after.status.meshActors>reports.input.before.status.meshActors,'Placed geometry must reach the actual Unreal world');
const editorStatus=await read('release-packaged-native-final/last-status.json');assert.equal(editorStatus.bakeAvailable,false,'Native viewing was checked without an available editor');
const unitLog=await fs.readFile(path.join(checks,'release-unit-tests.log'),'utf8'),browserLog=await fs.readFile(path.join(checks,'release-browser-tests.log'),'utf8');
const unitCount=Number(unitLog.match(/Tests\s+(\d+)\s+passed/)?.[1]);assert.ok(unitCount>=25);
assert.match(browserLog,/5 passed/);
assert.match(await fs.readFile(path.join(checks,'release-installer-extract.log'),'utf8'),/Everything is Ok/);
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
const installer=path.join(release,`ArchAI-Setup-${version}.exe`),runtime='resources/unreal/ArchaiRender/Binaries/Win64/ArchaiEmbedded.dll';
const installedLibrary=path.join(release,'win-unpacked',runtime),extractedLibrary=path.join(checks,`installer-extracted-${version}`,runtime);
const [sha256,libraryHash,extractedHash,sourceHash,hostHash,extractedHostHash]=await Promise.all([
 digest(installer),digest(installedLibrary),digest(extractedLibrary),digest(path.join(checks,'ArchaiEmbedded/Binaries/Win64/ArchaiEmbedded-Win64-Shipping.dll')),
 digest(path.join(release,'win-unpacked/resources/unreal-native/archai_unreal_host.node')),
 digest(path.join(checks,`installer-extracted-${version}/resources/unreal-native/archai_unreal_host.node`)),
]);
assert.equal(libraryHash,sourceHash);assert.equal(libraryHash,extractedHash);assert.equal(hostHash,extractedHostHash);
const result={success:true,version,verifiedAt:new Date().toISOString(),installer:{path:installer,bytes:(await fs.stat(installer)).size,sha256},
 engine:'Unreal Engine 5.8.1 source build',hosting:'native library inside Archai',librarySha256:libraryHash,nativeHostSha256:hostHash,
 installerPayloadMatchesTestedRuntime:true,editorNotRequiredForViewing:true,unitTests:unitCount,browserTests:5,
 tests:reports,existingProjects:'Verification used isolated profiles and synthetic projects; existing projects were not opened or modified.',
 limitations:['Physical headset testing was not performed.','Production project uploads were not performed.','The million-triangle benchmark is synthetic; the Lightmass verification uses a small scene.']};
const reportFile=path.join(release,'verification.json');await fs.writeFile(reportFile,JSON.stringify(result,null,2));
await fs.writeFile(installer+'.sha256',sha256+'  '+path.basename(installer)+'\n');
await fs.writeFile(path.join(checks,'native-check-status.json'),JSON.stringify({stage:'Verified release ready',version,installer,report:reportFile,updated:new Date().toISOString()},null,2));
console.log(JSON.stringify({success:true,version,installer,sha256,unitTests:unitCount,browserTests:5,report:reportFile},null,2));
