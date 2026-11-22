// Campaign services: who counts as a lead for each, and what reaches the prompts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-services-'));
const { judge, createCampaign, updateCampaign } = await import('../src/leads.ts');
const { promptVars, SERVICE_KEYS } = await import('../src/services.ts');

const biz = (website_url = '', reviews: number | null = null) => ({ company_name: 'Pipe Pros', phone: '', email: '', website_url, address: '', postcode: '', town: 'Durham',
  industry: 'plumbers', source: 'places', source_ref: '', rating: null, reviews });
const site = (issues = {}, seo = {}) => ({ reachable: true, url: 'https://pp.example', issues, seo, email: null, social: {} });

test('each service picks its own leads', () => {
  assert.equal(judge(biz(), null, 'both'), 'No website found for this business');
  assert.equal(judge(biz(), null, 'both', 'seo'), null);
  assert.match(judge(biz('x'), site({}, { no_title: true }), 'both', 'seo')!, /missing search basics: no title/);
  assert.equal(judge(biz('x'), site(), 'both', 'seo'), null);
  assert.match(judge(biz('', 40), null, 'both', 'ai')!, /40 reviews/);
  assert.ok(judge(biz(), null, 'both', 'ai'), 'AI takes businesses with no website too');
  assert.match(judge(biz('x'), site({ no_ssl: true }), 'both', 'care_plan')!, /not being looked after: no ssl/);
  assert.equal(judge(biz('x'), site(), 'both', 'care_plan'), null);
  assert.ok(judge(biz('x'), site(), 'both', 'cro'));
  assert.equal(judge(biz(), null, 'both', 'cro'), null);
  assert.deepEqual(SERVICE_KEYS, ['web_design', 'seo', 'ai', 'care_plan', 'cro']);
});

test('a campaign keeps its service, prompts get its words, and a concept only goes with services that use one', () => {
  const c = createCampaign({ name: 'AI for trades', industries: 'plumbers', towns: 'Durham', lead_type: 'both', max_leads: 10, sources: ['places'], concept: true, service: 'ai' });
  assert.deepEqual([c.service, c.concept], ['ai', 0]);
  assert.match(promptVars(c.id).offer, /jobs in their business that AI could take off their hands/);
  assert.equal(promptVars(null).service, 'Web design');
  const kept = updateCampaign(c.id, { name: 'AI for trades', industries: 'plumbers', towns: 'Durham', lead_type: 'both', max_leads: 10, sources: ['places'] });
  assert.equal(kept.service, 'ai', 'an update without a service keeps it');
  const web = createCampaign({ name: 'Sites', industries: 'plumbers', towns: 'Durham', lead_type: 'both', max_leads: 10, sources: ['places'], concept: true });
  assert.deepEqual([web.service, web.concept], ['web_design', 1]);
});
