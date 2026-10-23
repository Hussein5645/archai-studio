import { z } from 'zod';
import { RenderLightsSchema } from './renderLights.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const texture = z.object({ hash, matrix: z.array(z.number().finite()).length(9) });
export const LiveMaterialSchema = z.object({
  color: vector, emissive: vector, opacity: z.number().min(0).max(1),
  roughness: z.number().min(0).max(1), metalness: z.number().min(0).max(1),
  unlit: z.boolean(), vertexColors: z.boolean(), transparent: z.boolean(),
  alphaTest: z.number().min(0).max(1), normalScale: z.tuple([z.number().finite(), z.number().finite()]),
  aoIntensity: z.number().min(0).max(1),
  map: texture.nullable(), normalMap: texture.nullable(), roughnessMap: texture.nullable(),
  metalnessMap: texture.nullable(), emissiveMap: texture.nullable(),
  aoMap: texture.nullable(), alphaMap: texture.nullable(),
});
export const LiveNodeSchema = z.object({
  id: z.string().min(1).max(256), elementId: z.string().min(1).max(128), mesh: hash,
  matrix: z.array(z.number().finite()).length(16), material: LiveMaterialSchema,
});
export const LiveAssetSchema=z.object({hash,kind:z.enum(['mesh','texture']),bytes:z.instanceof(Uint8Array)});
export const UnrealAssetsInput=z.object({projectId:z.string().min(1).max(64),assets:z.array(LiveAssetSchema).max(200000)})
 .superRefine((input,ctx)=>{if(input.assets.reduce((sum,asset)=>sum+asset.bytes.byteLength,0)>512*1024*1024)ctx.addIssue({code:'custom',message:'Asset batch exceeds 512 MB'});});
export const UnrealLiveInput = z.object({
  protocol: z.literal(1), projectId: z.string().min(1).max(64),
  viewId: z.string().max(512).optional(),
  nodes: z.array(LiveNodeSchema).max(200_000),
  assets: z.array(LiveAssetSchema).max(200_000),
  settings: z.object({ lights: RenderLightsSchema, sunEnabled: z.boolean(), sunIntensity: z.number().min(0).max(10),
    skyIntensity: z.number().min(0).max(5), altitude: z.number().min(-10).max(90), azimuth: z.number().finite(), exposure: z.number().min(-4).max(4),
    exposureMode: z.enum(['auto', 'manual']).default('auto'), bloom: z.number().min(0).max(2).default(0.1), ambientOcclusion: z.number().min(0).max(2).default(1), bakedPreview: z.boolean().default(false) }),
  camera: z.object({ position: vector, target: vector, fov: z.number().min(10).max(120).optional() }).nullable(),
  sunDirection: vector,
}).superRefine((input, ctx) => {
  if (input.assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0) > 512 * 1024 * 1024)
    ctx.addIssue({ code: 'custom', message: 'Live scene update exceeds 512 MB' });
  if (new Set(input.nodes.map((node) => node.id)).size !== input.nodes.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate live scene node' });
});
export type UnrealLiveScene = z.infer<typeof UnrealLiveInput>;
export type LiveNode = z.infer<typeof LiveNodeSchema>;
export type LiveMaterial = z.infer<typeof LiveMaterialSchema>;

export function* liveAssetBatches(assets:UnrealLiveScene['assets'],budget=128*1024*1024):Generator<UnrealLiveScene['assets']>{
  let batch:UnrealLiveScene['assets']=[],bytes=0;
  for(const asset of assets){
    if(batch.length&&bytes+asset.bytes.byteLength>budget){yield batch;batch=[];bytes=0;}
    batch.push(asset);bytes+=asset.bytes.byteLength;
  }
  if(batch.length)yield batch;
}

/** Positions, normals, UVs and linear vertex colours, followed by triangle indices. */
export function* liveMeshValidation(bytes: Uint8Array): Generator<void> {
  if (bytes.byteLength < 16) throw new Error('Invalid live mesh header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertices = view.getUint32(4, true), indices = view.getUint32(8, true);
  if (view.getUint32(0, true) !== 0x314d4341 || !vertices || !indices || indices % 3 ||
      16 + vertices * 48 + indices * 4 !== bytes.byteLength) throw new Error('Invalid live mesh size');
  const values=vertices*12;
  const data=(bytes.byteOffset+16)%4===0?new Float32Array(bytes.buffer,bytes.byteOffset+16,values):null;
  for(let start=0;start<values;start+=65536){
    for(let index=start;index<Math.min(values,start+65536);index++)if(!Number.isFinite(data?data[index]:view.getFloat32(16+index*4,true)))throw new Error('Invalid live mesh coordinates');
    yield;
  }
  for(let start=0;start<indices;start+=65536){
    for(let index=start;index<Math.min(indices,start+65536);index++)if(view.getUint32(16+vertices*48+index*4,true)>=vertices)throw new Error('Invalid live mesh index');
    yield;
  }
}
export function validateLiveMesh(bytes:Uint8Array):void { for(const step of liveMeshValidation(bytes))void step; }
