import { type ReactNode } from 'react';
import { clsx } from 'clsx';

interface Props { children: ReactNode; className?: string; variant?: 'default' | 'success' | 'warning' | 'error' | 'info'; }

export function Badge({ children, className, variant = 'default' }: Props) {
  return (
    <span className={clsx(
      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium tracking-wide',
      variant === 'success' && 'text-emerald-400 bg-emerald-400/10',
      variant === 'warning' && 'text-amber-400 bg-amber-400/10',
      variant === 'error' && 'text-red-400 bg-red-400/10',
      variant === 'info' && 'text-blue-400 bg-blue-400/10',
      variant === 'default' && 'text-slate-400 bg-slate-400/10',
      className
    )}>
      {children}
    </span>
  );
}
