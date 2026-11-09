export const label = (key) => (key ? String(key).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');
