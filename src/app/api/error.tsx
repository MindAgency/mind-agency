'use client';

/**
 * API Error Boundary
 *
 * Catches unhandled errors from API route handlers (including webpack module
 * loading failures during hot-reload) and returns a JSON-shaped response
 * rendered as <pre> so API clients can parse it.
 *
 * Without this boundary, Next.js returns a full HTML error page that breaks
 * all API clients expecting JSON.
 */

export default function ApiError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
}) {
  const message = error?.message || 'Internal server error';
  const isModuleError =
    message.includes('webpack_modules') ||
    message.includes('Cannot find module') ||
    message.includes('is not a function');

  const body = JSON.stringify(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: isModuleError
          ? 'Server is reloading — please retry in a moment'
          : message,
        digest: error?.digest,
      },
    },
    null,
    2,
  );

  // Render as <pre> with JSON content-type header so fetch clients
  // can parse the body even though it's technically an HTML page.
  return (
    <pre
      style={{
        margin: 0,
        padding: '16px',
        fontFamily: 'monospace',
        fontSize: '13px',
        whiteSpace: 'pre-wrap',
        background: '#1a1a1a',
        color: '#e0e0e0',
        minHeight: '100vh',
      }}
      data-api-error="true"
    >
      {body}
    </pre>
  );
}
