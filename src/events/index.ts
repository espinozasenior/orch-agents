/**
 * Events module — Phase 9C
 *
 * Serial batch event system with backpressure, coalescing, and
 * text delta accumulation.
 */

export { RetryableError } from './retryable-error';

export {
  SerialBatchUploader,
  type SerialBatchUploaderConfig,
} from './serial-batch-uploader';

export {
  CoalescingUploader,
  type CoalescingUploaderConfig,
  jsonMergePatch,
} from './coalescing-uploader';

export {
  TextDeltaAccumulator,
  type TextDeltaAccumulatorConfig,
} from './text-delta-accumulator';
