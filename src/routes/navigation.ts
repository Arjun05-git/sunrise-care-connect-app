import {
  Activity, BadgeIndianRupee, Bell, Building2, CalendarClock, CalendarDays, CalendarRange, FileBarChart, FolderHeart, Home, LayoutDashboard, Settings2,
  FileText, LifeBuoy, Plug, ShieldCheck, Stethoscope, Sun, User, UserCog, Users, UsersRound,
} from 'lucide-react';
import type { NavItem } from '@/components/layout/nav';

export const PATIENT_NAV: NavItem[] = [
  { to: '/p', labelKey: 'nav.home', icon: Home, end: true },
  { to: '/p/appointments', labelKey: 'nav.appointments', icon: CalendarDays },
  { to: '/p/records', labelKey: 'nav.records', icon: FolderHeart },
  { to: '/p/profile', labelKey: 'nav.profile', icon: User },
];

export const DOCTOR_NAV: NavItem[] = [
  { to: '/d', labelKey: 'nav.today', icon: Sun, end: true },
  { to: '/d/calendar', labelKey: 'nav.calendar', icon: CalendarRange },
  { to: '/d/patients', labelKey: 'nav.patients', icon: Users },
  { to: '/d/profile', labelKey: 'nav.profile', icon: UserCog },
];

export const ADMIN_NAV: NavItem[] = [
  { to: '/a', labelKey: 'admin.dashboard', icon: LayoutDashboard, end: true },
  { to: '/a/appointments', labelKey: 'admin.appointments', icon: CalendarClock },
  { to: '/a/doctors', labelKey: 'admin.doctors', icon: Stethoscope },
  { to: '/a/masters', labelKey: 'admin.masters', icon: Building2 },
  { to: '/a/fees', labelKey: 'admin.fees', icon: BadgeIndianRupee },
  { to: '/a/policies', labelKey: 'admin.policies', icon: Settings2 },
  { to: '/a/payments', labelKey: 'admin.payments', icon: Activity },
  { to: '/a/notifications', labelKey: 'admin.notifications', icon: Bell },
  { to: '/a/support', labelKey: 'admin.support', icon: LifeBuoy },
  { to: '/a/content', labelKey: 'admin.content', icon: FileText },
  { to: '/a/users', labelKey: 'admin.users', icon: UsersRound },
  { to: '/a/integrations', labelKey: 'admin.integrations', icon: Plug },
  { to: '/a/audit', labelKey: 'admin.audit', icon: ShieldCheck },
  { to: '/a/reports', labelKey: 'admin.reports', icon: FileBarChart },
  { to: '/a/settings', labelKey: 'admin.settings', icon: UserCog },
];
