import { useEffect, useRef, useState } from 'react';
import {
  createBridgeTask,
  waitForBridgeTask,
  type BridgeTask,
  type BridgeTaskResponse,
  type BridgeTaskRequest,
} from '../../shared/bridge/client';

function toBridgeErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'LLM Clip could not reach the local handoff bridge.';
}

function createPendingTask(acceptedTask: BridgeTaskResponse, request: BridgeTaskRequest): BridgeTask {
  const now = new Date().toISOString();

  return {
    id: acceptedTask.taskId,
    createdAt: now,
    updatedAt: now,
    status: acceptedTask.status,
    workspaceId: request.workspaceId,
    sessionId: acceptedTask.delivery.sessionId,
    target: request.target,
    intent: request.intent,
    title: request.payload.title,
    bundlePath: acceptedTask.bundlePath,
    bundleSignature: '',
    delivery: acceptedTask.delivery,
  };
}

export function useBridgeHandoff() {
  const [activeTask, setActiveTask] = useState<BridgeTask | null>(null);
  const [handoffError, setHandoffError] = useState('');
  const [isBridgeSubmitting, setIsBridgeSubmitting] = useState(false);
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      activeControllerRef.current?.abort();
      isMountedRef.current = false;
    };
  }, []);

  function setTaskSafely(task: BridgeTask | null, requestId: number) {
    if (isMountedRef.current && requestId === requestIdRef.current) {
      setActiveTask(task);
    }
  }

  function setErrorSafely(message: string, requestId: number) {
    if (isMountedRef.current && requestId === requestIdRef.current) {
      setHandoffError(message);
    }
  }

  function setSubmittingSafely(value: boolean, requestId: number) {
    if (isMountedRef.current && requestId === requestIdRef.current) {
      setIsBridgeSubmitting(value);
    }
  }

  async function submitTask(request: BridgeTaskRequest) {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    activeControllerRef.current?.abort();
    activeControllerRef.current = new AbortController();
    const { signal } = activeControllerRef.current;

    setSubmittingSafely(true, requestId);
    setHandoffError('');
    setTaskSafely(null, requestId);

    try {
      const acceptedTask = await createBridgeTask(request);
      const pendingTask = createPendingTask(acceptedTask, request);
      setTaskSafely(pendingTask, requestId);

      if (acceptedTask.delivery.state === 'queued' || acceptedTask.delivery.state === 'delivering') {
        const finalTask = await waitForBridgeTask(acceptedTask.taskId, {
          signal,
          onUpdate: (task) => {
            setTaskSafely(task, requestId);
          },
        });
        setTaskSafely(finalTask, requestId);
        return finalTask;
      }

      return pendingTask;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      const message = toBridgeErrorMessage(error);
      const latestTask = (error as Error & { task?: BridgeTask | null }).task;
      if (latestTask) {
        setTaskSafely(latestTask, requestId);
      }
      setErrorSafely(message, requestId);
      throw new Error(message);
    } finally {
      if (activeControllerRef.current?.signal === signal) {
        activeControllerRef.current = null;
      }
      setSubmittingSafely(false, requestId);
    }
  }

  return {
    activeTask,
    handoffError,
    isBridgeSubmitting,
    setActiveTask,
    setHandoffError,
    submitTask,
  };
}
