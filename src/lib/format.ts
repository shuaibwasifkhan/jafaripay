export function formatAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatUSDC(amount: string): string {
  const n = parseFloat(amount);
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n);
}

export function formatDate(unixTs: number): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(unixTs * 1000));
}

export function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    succeeded: 'text-emerald-400 bg-emerald-400/10',
    requires_payment: 'text-amber-400 bg-amber-400/10',
    processing: 'text-blue-400 bg-blue-400/10',
    failed: 'text-red-400 bg-red-400/10',
    expired: 'text-slate-400 bg-slate-400/10',
    cancelled: 'text-slate-400 bg-slate-400/10',
  };
  return map[status] || 'text-slate-400 bg-slate-400/10';
}

export function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    succeeded: 'Succeeded', requires_payment: 'Requires Payment',
    processing: 'Processing', failed: 'Failed', expired: 'Expired', cancelled: 'Cancelled',
  };
  return map[status] || status;
}
