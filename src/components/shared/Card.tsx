import { type ReactNode } from 'react';
import { clsx } from 'clsx';

interface Props { children: ReactNode; className?: string; glass?: boolean; }

export function Card({ children, className, glass }: Props) {
  return (
    <div className={clsx(
      'rounded-2xl border bg-white shadow-soft',
      glass && 'bg-white/80 backdrop-blur-md border-sand-200',
      className
    )}>
      {children}
    </div>
  );
}
