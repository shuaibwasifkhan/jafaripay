import { type ReactNode } from 'react';
import { clsx } from 'clsx';

interface Props { children: ReactNode; className?: string; variant?: 'default' | 'success' | 'warning' | 'error' | 'info'; }

export function Badge({ children, className, variant = 'default' }: Props) {
  return (
        <span className={clsx(
      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium tracking-wide',
      variant === 'success' && 'text-forest-700 bg-forest-100',
      variant === 'warning' && 'text-gold-700 bg-gold-100',
      variant === 'error' && 'text-red-600 bg-red-50',
      variant === 'info' && 'text-teal-700 bg-teal-50',
      variant === 'default' && 'text-slate-600 bg-sand-100',
      className
    )}>
      {children}
    </span>
  );
}
