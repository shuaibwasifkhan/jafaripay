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
    // Light fintech palette (presentation: status badge classes only).
    succeeded: 'text-forest-700 bg-forest-100',
    requires_payment: 'text-gold-700 bg-gold-100',
    processing: 'text-teal-700 bg-teal-50',
    failed: 'text-red-600 bg-red-50',
    expired: 'text-slate-500 bg-sand-100',
    cancelled: 'text-slate-500 bg-sand-100',
  };
  return map[status] || 'text-slate-600 bg-sand-100';
}

export function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    succeeded: 'Succeeded', requires_payment: 'Requires Payment',
    processing: 'Processing', failed: 'Failed', expired: 'Expired', cancelled: 'Cancelled',
  };
  return map[status] || status;
}
