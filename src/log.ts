export type ErrorHandler = (message: string, error?: unknown) => void;

let errorHandler: ErrorHandler | null = null;

export function setErrorHandler(handler: ErrorHandler | null): void {
  errorHandler = handler;
}

export function reportError(message: string, error?: unknown): void {
  if (errorHandler) {
    errorHandler(message, error);
    return;
  }
  console.error(message, error);
}
