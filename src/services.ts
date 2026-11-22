// What a campaign sells. Each service decides which businesses count as leads, what Claude looks for when it rates
// them, and what the emails offer. Plain rules; the words go into the prompts as {service}, {focus} and {offer}.
import { db } from './db.ts';
import type { SiteCheck } from './sitecheck.ts';

type Judge = (f: { website_url: string; reviews: number | null }, site: SiteCheck | null, leadType: string) => string | null;
export type Service = { label: string; focus: string; offer: string; finds: string; concept: boolean; judge: Judge };

const live = (site: SiteCheck | null) => !!site?.reachable;
const names = (o: Record<string, unknown>) => Object.keys(o).map(k => k.replace(/^no_/, 'no ').replace(/_/g, ' ')).join(', ');

export const SERVICES = {
  web_design: {
    label: 'Web design',
    focus: 'a new or better website',
    offer: 'a free concept of what a new or better website could look like for them',
    finds: 'Businesses with no website or an outdated one, as chosen below.',
    concept: true,
    judge: (f, site, type) => {
      if (!f.website_url) return type !== 'outdated_website' ? 'No website found for this business' : null;
      if (!live(site)) return type !== 'outdated_website' ? 'Website listed but unreachable' : null;
      const issues = Object.keys(site!.issues);
      return issues.length && type !== 'no_website' ? `Outdated website: ${issues.join(', ')}` : null;
    },
  },
  seo: {
    label: 'SEO and AI search (GEO)',
    focus: 'getting found on Google and in AI answers such as ChatGPT, so more local customers find them before a competitor',
    offer: 'a free check of how they show up on Google and in AI answers, with the three changes that would move them up most',
    finds: 'Businesses with a working website that is missing search basics.',
    concept: false,
    judge: (f, site) => {
      if (!live(site)) return null;
      const gaps = Object.keys(site!.seo);
      return gaps.length ? `Website missing search basics: ${names(site!.seo)}` : null;
    },
  },
  ai: {
    label: 'AI services and automation',
    focus: 'saving time and winning more work with AI: replying to every enquiry and missed call straight away, a chat assistant on their website, instant quotes and automating repeat admin',
    offer: 'a free short list of the jobs in their business that AI could take off their hands, and what each would save',
    finds: 'Established businesses, with or without a website. Ones with plenty of reviews come first when Claude rates them.',
    concept: false,
    judge: (f, site) => f.reviews && f.reviews >= 10 ? `Busy business (${f.reviews} reviews) likely to have enquiries to automate`
      : live(site) ? 'Business with a website, ready for AI tools' : 'Business that relies on calls and messages',
  },
  care_plan: {
    label: 'Website care plan',
    focus: 'keeping their website secure, up to date, backed up and quick, so it keeps working for them without them having to think about it',
    offer: 'a free health check of their website, showing what needs fixing now',
    finds: 'Businesses whose website works but is not being looked after: no secure connection, not built for phones or an old copyright year.',
    concept: false,
    judge: (f, site) => live(site) && Object.keys(site!.issues).length ? `Website not being looked after: ${names(site!.issues)}` : null,
  },
  cro: {
    label: 'Conversion rate optimisation',
    focus: 'turning more of the people who already visit their website into enquiries and sales',
    offer: 'a free review of where their website loses enquiries, with quick fixes they could make this week',
    finds: 'Businesses with a working website. Ones with plenty of reviews, and so plenty of visitors, come first when Claude rates them.',
    concept: true,
    judge: (f, site) => live(site) ? (f.reviews && f.reviews >= 10 ? `Popular business (${f.reviews} reviews) whose website could turn more visitors into enquiries` : 'Working website that could turn more visitors into enquiries') : null,
  },
} satisfies Record<string, Service>;

export type ServiceKey = keyof typeof SERVICES;
export const SERVICE_KEYS = Object.keys(SERVICES) as ServiceKey[];
export const service = (key: string | null | undefined): Service => SERVICES[(key ?? '') as ServiceKey] ?? SERVICES.web_design;
// The words a prompt gets for a campaign's service. A lead with no campaign is treated as web design.
export function promptVars(campaignId: number | null | undefined) {
  const row = campaignId ? db.prepare('SELECT service FROM campaigns WHERE id = ?').get(campaignId) as { service: string } | undefined : undefined;
  const s = service(row?.service);
  return { service: s.label, focus: s.focus, offer: s.offer };
}
