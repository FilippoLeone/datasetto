import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { dismissToast, toasts } from '@/state/ui';

const ICONS = {
  info: <Info size={18} className="text-link" />,
  success: <CheckCircle2 size={18} className="text-success" />,
  warning: <AlertTriangle size={18} className="text-warning" />,
  error: <XCircle size={18} className="text-live" />,
};

export const ToastHost = () => (
  <div className="pointer-events-none fixed top-3 right-3 z-[60] flex w-80 max-w-[calc(100vw-24px)] flex-col gap-2 safe-top">
    {toasts.value.map((toast) => (
      <div
        key={toast.id}
        role="status"
        className={cn('pointer-events-auto flex items-start gap-3 rounded-md bg-elevated px-3 py-2.5 text-sm shadow-pop animate-slide-up', 'border-l-2', {
          'border-link': toast.type === 'info',
          'border-success': toast.type === 'success',
          'border-warning': toast.type === 'warning',
          'border-live': toast.type === 'error',
        })}
      >
        <span className="mt-px shrink-0">{ICONS[toast.type]}</span>
        <span className="min-w-0 flex-1 break-words text-text-bright">{toast.message}</span>
        <button type="button" aria-label="Dismiss" className="shrink-0 text-text-muted hover:text-text-bright" onClick={() => dismissToast(toast.id)}>
          <X size={16} />
        </button>
      </div>
    ))}
  </div>
);
