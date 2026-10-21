import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-preact';
import { cn } from '@/lib/cn';
import { MOTION, useListPresence } from '@/lib/motion';
import { dismissToast, toasts } from '@/state/ui';

const ICONS = {
  info: <Info size={18} className="text-link" />,
  success: <CheckCircle2 size={18} className="text-success" />,
  warning: <AlertTriangle size={18} className="text-warning" />,
  error: <XCircle size={18} className="text-live" />,
};

export const ToastHost = () => {
  // A dismissed toast stays for its slide-out (data-state="closed", see styles/app.css).
  const entries = useListPresence(toasts.value, (toast) => toast.id, MOTION.fast);
  return (
    <div className="pointer-events-none fixed top-3 right-[max(0.75rem,env(safe-area-inset-right,0px))] z-[60] flex w-80 max-w-[calc(100vw-24px)] flex-col gap-2 safe-top">
      {entries.map(({ key, item: toast, state }) => (
        <div
          key={key}
          data-state={state}
          role="status"
          className={cn('motion-toast pointer-events-auto flex items-start gap-3 rounded-md bg-elevated px-3 py-2.5 text-sm shadow-pop', 'border-l-2', {
            'border-link': toast.type === 'info',
            'border-success': toast.type === 'success',
            'border-warning': toast.type === 'warning',
            'border-live': toast.type === 'error',
          })}
        >
          <span className="mt-px shrink-0">{ICONS[toast.type]}</span>
          <span className="min-w-0 flex-1 break-words text-text-bright">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="-m-2 shrink-0 p-2 text-text-muted transition-colors duration-150 hover:text-text-bright pointer-coarse:-m-3 pointer-coarse:p-3"
            onClick={() => dismissToast(toast.id)}
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
};
