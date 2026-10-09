/** Messages between the main thread (./client.ts) and the kernel worker (./worker.ts). */
import type { Body, EvaluationContext, MeshData } from './types';

export type KernelRequest = { type: 'evaluate'; requestId: number; body: Body; context: EvaluationContext } | { type: 'drop'; bodyId: string };

export type KernelResponse =
  | { type: 'ready'; initMs: number }
  | { type: 'failed'; message: string }
  | { type: 'result'; requestId: number; bodyId: string; mesh: MeshData; ms: number }
  | { type: 'error'; requestId: number; bodyId: string; featureId: string; message: string };
