/** Indian rupee amount (whole rupees), in the UI language's digits and grouping. */
export const inr = (n: number, locale = 'en') =>
  new Intl.NumberFormat(locale === 'ml' ? 'ml-IN' : 'en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
