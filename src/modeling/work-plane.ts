import { planeFrame } from './kernel/sketch';
import type { SketchPlane } from './kernel/types';
import type { Point3 } from './inference';

const add = (a: Point3, b: Point3): Point3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Point3, value: number): Point3 => [a[0] * value, a[1] * value, a[2] * value];
const dot3 = (a: Point3, b: Point3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point3, b: Point3): Point3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Point3): Point3 => {
  const size = Math.hypot(...a);
  if (size < 1e-9) throw new Error('Work-plane points must not be coincident or collinear');
  return scale(a, 1 / size);
};

/** Plane construction and projection that deliberately has no camera/view side effects. */
export class WorkPlaneService {
  static fromThreePoints(origin: Point3, xPoint: Point3, planePoint: Point3): SketchPlane {
    const xAxis = unit(subtract(xPoint, origin));
    const normal = unit(cross(xAxis, subtract(planePoint, origin)));
    return { kind: 'custom', origin: [...origin], normal, xAxis };
  }

  static offset(plane: SketchPlane, distance: number): SketchPlane {
    if (plane.kind === 'plane') return { ...plane, offset: plane.offset + distance };
    const frame = planeFrame(plane);
    return { ...plane, origin: add(plane.origin, scale(frame.normal, distance)) };
  }

  static flip(plane: SketchPlane): SketchPlane {
    const frame = planeFrame(plane);
    return { kind: 'custom', origin: [...frame.origin], normal: scale(frame.normal, -1), xAxis: [...frame.u] };
  }

  static rotate(plane: SketchPlane, axis: 'x' | 'y', degrees: number): SketchPlane {
    const frame = planeFrame(plane);
    const rotationAxis = axis === 'x' ? frame.u : frame.v;
    const rotate = (vector: Point3): Point3 => {
      const radians = (degrees * Math.PI) / 180;
      return add(add(scale(vector, Math.cos(radians)), scale(cross(rotationAxis, vector), Math.sin(radians))), scale(rotationAxis, dot3(rotationAxis, vector) * (1 - Math.cos(radians))));
    };
    return { kind: 'custom', origin: [...frame.origin], normal: unit(rotate(frame.normal)), xAxis: unit(rotate(frame.u)) };
  }

  static projectRay(plane: SketchPlane, rayOrigin: Point3, rayDirection: Point3): Point3 | null {
    const frame = planeFrame(plane);
    const denominator = dot3(frame.normal, rayDirection);
    if (Math.abs(denominator) < 1e-9) return null;
    const distance = dot3(subtract(frame.origin, rayOrigin), frame.normal) / denominator;
    return add(rayOrigin, scale(rayDirection, distance));
  }
}
