import { type ReactNode, type ButtonHTMLAttributes } from 'react';
import { clsx } from 'clsx';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export function Button({ children, variant = 'primary', size = 'md', loading, className, disabled, ...rest }: Props) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' && 'px-3 py-1.5 text-sm',
        size === 'md' && 'px-4 py-2.5 text-sm',
        size === 'lg' && 'px-6 py-3.5 text-base',
        variant === 'primary' && 'bg-[#0a0f1e] text-white hover:bg-[#0d1529] active:bg-[#060b18]',
        variant === 'secondary' && 'bg-white/8 text-slate-200 border border-white/10 hover:bg-white/12',
        variant === 'ghost' && 'text-slate-400 hover:text-slate-200 hover:bg-white/6',
        variant === 'danger' && 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20',
        className
      )}
    >
      {loading && (
        <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  );
}
