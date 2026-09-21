import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { clsx } from 'clsx';

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={() => { void copy(); }}
      title="Copy to clipboard"
      className={clsx('p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/8 transition-all', className)}
    >
      {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
    </button>
  );
}
