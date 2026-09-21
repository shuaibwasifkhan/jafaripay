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
      {label && <label className="text-sm font-medium text-slate-300">{label}</label>}
      <input
        {...rest}
        className={clsx(
          'w-full px-3.5 py-2.5 rounded-xl bg-white/6 border text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all',
          error ? 'border-red-500/50' : 'border-white/10 focus:border-blue-500/50',
          className
        )}
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
