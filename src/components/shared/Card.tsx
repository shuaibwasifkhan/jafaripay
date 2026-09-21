import { type ReactNode } from 'react';
import { clsx } from 'clsx';

interface Props { children: ReactNode; className?: string; glass?: boolean; }

export function Card({ children, className, glass }: Props) {
  return (
    <div className={clsx(
      'rounded-2xl border',
      glass
        ? 'bg-white/6 backdrop-blur-md border-white/10'
        : 'bg-[#0d1225] border-white/8',
      className
    )}>
      {children}
    </div>
  );
}
