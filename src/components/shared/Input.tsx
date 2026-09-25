import { type InputHTMLAttributes } from 'react';
import { clsx } from 'clsx';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Input({ label, error, hint, className, ...rest }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <label className="text-sm font-medium text-slate-600">{label}</label>}
            <input
        {...rest}
        className={clsx(
          'w-full px-3.5 py-2.5 rounded-xl bg-white border text-sm text-ink placeholder-slate-400 caret-ink focus:outline-none focus:ring-2 focus:ring-forest-500/40 transition-all',
          error ? 'border-red-300 focus:border-red-400' : 'border-sand-300 focus:border-forest-500/60',
          className
        )}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
