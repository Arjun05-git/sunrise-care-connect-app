import { Baby, Bone, Droplet, Ear, Flower2, HeartPulse, Sparkles, Stethoscope, type LucideIcon } from 'lucide-react';

const ICONS: Record<string, LucideIcon> = { Baby, Bone, Droplet, Ear, Flower2, HeartPulse, Sparkles, Stethoscope };
/** Department icon by the name stored in departments.icon (admin-configurable). */
export function DeptIcon({ name, className }: { name: string; className?: string }) {
  const I = ICONS[name] ?? Stethoscope;
  return <I className={className} aria-hidden />;
}
