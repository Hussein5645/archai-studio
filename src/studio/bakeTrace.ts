import type { RenderLight } from '@shared/renderLights';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export interface BakeInput {
  positions: Float32Array;
  normals: Float32Array;
  /** Triangles of opaque shadow casters, in world metres. */
  triangles: Float32Array;
  albedos: Float32Array;
  emission: Float32Array;
  sun: [number, number, number];
  sunIntensity: number;
  skyIntensity: number;
  environment: { data: Float32Array; width: number; height: number; rotation: number } | null;
  lights?: RenderLight[];
  samples: number;
  bounces: number;
}

/** Diffuse static illumination; textures stay on the exported unlit materials. */
export function traceBake(input: BakeInput, progress?: (fraction: number) => void): Float32Array {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(input.triangles, 3));
  const bvh = input.triangles.length ? new MeshBVH(geometry, { indirect: true }) : null;
  const sun = new THREE.Vector3(...input.sun).normalize();
  const ray = new THREE.Ray();
  let seed = 123456789;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const hemisphere = (normal: THREE.Vector3) => {
    const phi = random() * Math.PI * 2,
      r = Math.sqrt(random());
    const tangent = new THREE.Vector3(
      Math.abs(normal.y) < 0.99 ? 0 : 1,
      Math.abs(normal.y) < 0.99 ? 1 : 0,
      0,
    )
      .cross(normal)
      .normalize();
    const bitangent = normal.clone().cross(tangent);
    return tangent
      .multiplyScalar(r * Math.cos(phi))
      .addScaledVector(bitangent, r * Math.sin(phi))
      .addScaledVector(normal, Math.sqrt(1 - r * r))
      .normalize();
  };
  const sky = (direction: THREE.Vector3) => {
    const e = input.environment;
    if (!e) return new THREE.Color(0.3, 0.35, 0.45).multiplyScalar(input.skyIntensity);
    const u = ((Math.atan2(direction.z, direction.x) + e.rotation) / (2 * Math.PI) + 0.5 + 2) % 1;
    const v = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)) / Math.PI + 0.5;
    const i =
      (Math.min(e.height - 1, Math.floor(v * e.height)) * e.width +
        Math.min(e.width - 1, Math.floor(u * e.width))) *
      4;
    return new THREE.Color(e.data[i] ?? 0, e.data[i + 1] ?? 0, e.data[i + 2] ?? 0).multiplyScalar(
      input.skyIntensity,
    );
  };
  const direct = (origin: THREE.Vector3, normal: THREE.Vector3) => {
    const intensity = (Math.max(0, normal.dot(sun)) * input.sunIntensity) / Math.PI;
    ray.set(origin, sun);
    const result = intensity > 0 && !bvh?.raycastFirst(ray, THREE.DoubleSide, 0.0001)
      ? new THREE.Color(intensity, intensity, intensity) : new THREE.Color(0, 0, 0);
    for (const light of input.lights ?? []) {
      if (!light.enabled || light.intensity <= 0) continue;
      const delta = new THREE.Vector3(...light.position).sub(origin);
      const distance = delta.length();
      if (distance > light.radius || distance < 0.001) continue;
      delta.divideScalar(distance);
      let cosine = Math.max(0, normal.dot(delta));
      if (!cosine) continue;
      if (light.kind !== 'point') {
        const yaw = light.yaw * Math.PI / 180, tilt = light.tilt * Math.PI / 180;
        const direction = new THREE.Vector3(Math.cos(tilt) * Math.cos(yaw), Math.sin(tilt), Math.cos(tilt) * Math.sin(yaw));
        const facing = -direction.dot(delta);
        cosine *= light.kind === 'spot' ? THREE.MathUtils.smoothstep(facing, Math.cos(Math.PI / 4), Math.cos(Math.PI / 6)) : Math.max(0, facing);
      }
      ray.set(origin, delta);
      const hit = bvh?.raycastFirst(ray, THREE.DoubleSide, 0.0001, distance - 0.002);
      if (!hit && cosine) result.add(new THREE.Color(light.color).multiplyScalar(cosine * light.intensity / (4 * Math.PI * Math.max(0.01, distance * distance) * 100) * Math.pow(1 - distance / light.radius, 2)));
    }
    return result;
  };
  const colors = new Float32Array(input.positions.length);
  const cache = new Map<string, THREE.Color>();
  const total = input.positions.length / 3;
  for (let vertex = 0; vertex < total; vertex++) {
    const offset = vertex * 3;
    const p = new THREE.Vector3().fromArray(input.positions, offset);
    const n = new THREE.Vector3().fromArray(input.normals, offset).normalize();
    const key = `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)},${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}`;
    let light = cache.get(key);
    if (!light) {
      const origin = p.clone().addScaledVector(n, 0.001);
      light = direct(origin, n);
      const indirect = new THREE.Color(0, 0, 0);
      for (let sample = 0; sample < input.samples; sample++) {
        let point = origin.clone(),
          normal = n.clone();
        const throughput = new THREE.Color(1, 1, 1);
        for (let bounce = 0; bounce <= input.bounces; bounce++) {
          const direction = hemisphere(normal);
          ray.set(point, direction);
          const hit = bvh?.raycastFirst(ray, THREE.DoubleSide, 0.0001);
          if (!hit) {
            indirect.add(sky(direction).multiply(throughput));
            break;
          }
          const face = hit.faceIndex ?? 0;
          indirect.add(new THREE.Color().fromArray(input.emission, face * 3).multiply(throughput));
          if (bounce === input.bounces) break;
          throughput.multiply(new THREE.Color().fromArray(input.albedos, face * 3));
          normal = hit.face!.normal.clone();
          if (normal.dot(direction) > 0) normal.negate();
          point = hit.point.clone().addScaledVector(normal, 0.001);
          indirect.add(direct(point, normal).multiply(throughput));
        }
      }
      light.add(indirect.multiplyScalar(1 / input.samples));
      cache.set(key, light);
    }
    light.toArray(colors, offset);
    if (vertex % 256 === 0) progress?.(vertex / total);
  }
  geometry.dispose();
  progress?.(1);
  return colors;
}
