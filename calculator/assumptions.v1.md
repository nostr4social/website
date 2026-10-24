# Cost of Custody Calculator: assumptions, version 1

Dated 2026-10-23. Currency USD; sterling converted at 1.3 USD per GBP where a source is in pounds.

Every number the calculator uses is listed here with its source. Each has a **typical** value, which the
page shows as the headline, and a **low** and **high** value, which bound the range shown beside every
line. Low always means the smaller cost. Any value can be overridden on the page or in a results link
with `a.<key>=<value>`; the machine-readable form of this document is `assumptions.v1.json` beside it.

A few of the unsourced values are not estimates of the world as it is but of the world Nostr4 is building: the
shares of age checks, moderation, moderation tooling and content-law programs that remain once an app hosts
nothing of its own. Their notes say so. Treat their ranges, not their typical values, as the claim.

Confidence means:

- **high**: read on the cited page or price list
- **medium**: derived from a primary source, or a primary figure converted or amortised
- **low**: a vendor page, a self-reported salary site, or a primary figure relayed second-hand
- **unsourced**: no public figure exists; a stated default, deliberately conservative

18 high, 62 unsourced, 9 low, 5 medium of 94 in all. The unsourced ones are the model's weakest points; treat the range, not the typical value, as the claim.

## Used by more than one line

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `eng_base_salary` | Backend or infra engineer, base salary | 135,980 | 110,000 | 180,000 | USD per year | high | [BLS Occupational Outlook: software developers, median annual wage](https://www.bls.gov/ooh/computer-and-information-technology/software-developers.htm) (2025-05) |
| `loaded_multiplier` | Benefits multiplier on base salary | 1.43× | 1.3× | 1.6× | multiplier | high | [BLS Employer Costs for Employee Compensation, private industry](https://www.bls.gov/news.release/ecec.nr0.htm) (2026-06) |
| `overhead_multiplier` | Overhead multiplier (equipment, office, software) | 1.15× | 1.05× | 1.25× | multiplier | unsourced | none |
| `compute_per_mau_year` | Serving and feed compute per active user | 1 | 0.5 | 3 | USD per MAU per year | medium | [Pinterest FY2025 Form 10-K: cost of revenue and MAU](https://www.sec.gov/Archives/edgar/data/1506293/000150629326000021/pins-20251231.htm) (2026-02) |
| `growth_default` | User growth over the next year, when not given | 25% | 0% | 50% | ratio of today's users | unsourced | none |
| `growth_decay` | Each year's growth rate as a share of the previous year's | 75% | 50% | 100% | ratio | low | [Equidam: benchmarks for startup revenue growth (15,000+ ventures)](https://www.equidam.com/benchmarks-for-startup-revenue-growth) (2024) |
| `migration_months` | Months for custody to leave, once work starts | 12 | 18 | 6 | months | unsourced | none |
| `posts_default` | Posts or messages a user a month, when neither given nor implied by the kind of app | 20 | 5 | 50 | count per MAU per month | unsourced | none |
| `mb_default` | Storage a user, when neither given nor implied by the kind of app | 50 | 10 | 200 | MB per MAU | unsourced | none |
| `kind_messaging_posts` | Messaging app: messages a user a month | 200 | 100 | 400 | count per MAU per month | unsourced | none |
| `kind_messaging_mb` | Messaging app: storage a user | 5 | 1 | 20 | MB per MAU | unsourced | none |
| `kind_messaging_egress_gb` | Messaging app: GB served a user a month | 0.2 | 0.05 | 1 | GB per MAU per month | unsourced | none |
| `kind_messaging_compute` | Messaging app: compute a user a year | 0.5 | 0.25 | 1.5 | USD per MAU per year | unsourced | none |
| `kind_feed_posts` | Media feed: posts a user a month | 20 | 5 | 50 | count per MAU per month | unsourced | none |
| `kind_feed_mb` | Media feed: storage a user | 500 | 100 | 2,000 | MB per MAU | unsourced | none |
| `kind_feed_egress_gb` | Media feed: GB served a user a month | 3 | 1 | 5 | GB per MAU per month | unsourced | none |
| `kind_feed_compute` | Media feed: compute a user a year | 2 | 1 | 5 | USD per MAU per year | unsourced | none |
| `kind_community_posts` | Community or forum: posts a user a month | 10 | 3 | 30 | count per MAU per month | unsourced | none |
| `kind_community_mb` | Community or forum: storage a user | 20 | 5 | 80 | MB per MAU | unsourced | none |
| `kind_community_egress_gb` | Community or forum: GB served a user a month | 0.5 | 0.1 | 2 | GB per MAU per month | unsourced | none |
| `kind_community_compute` | Community or forum: compute a user a year | 0.7 | 0.3 | 2 | USD per MAU per year | unsourced | none |
| `kind_marketplace_posts` | Marketplace: listings and messages a user a month | 5 | 1 | 15 | count per MAU per month | unsourced | none |
| `kind_marketplace_mb` | Marketplace: storage a user | 300 | 50 | 1,000 | MB per MAU | unsourced | none |
| `kind_marketplace_egress_gb` | Marketplace: GB served a user a month | 1 | 0.3 | 3 | GB per MAU per month | unsourced | none |
| `kind_marketplace_compute` | Marketplace: compute a user a year | 1 | 0.5 | 3 | USD per MAU per year | unsourced | none |
| `team_factor_one` | Team of one: engineering hours as a share of the default bands | 0.2× | 0.1× | 0.5× | multiplier | unsourced | none |
| `team_factor_ten` | Team of up to ten: engineering hours as a share of the default bands | 1× | 0.5× | 2× | multiplier | unsourced | none |
| `team_factor_fifty` | Team of up to fifty: engineering hours as a share of the default bands | 3× | 1.5× | 6× | multiplier | unsourced | none |
| `team_factor_more` | Team of more than fifty: engineering hours as a share of the default bands | 8× | 4× | 16× | multiplier | unsourced | none |

- `eng_base_salary`: US median for software developers. Infra specialists run higher; the median is the defensible default.
- `loaded_multiplier`: Private-industry total compensation divided by wages: benefits are 30% of compensation.
- `overhead_multiplier`: ECEC excludes non-compensation overhead. A conservative allowance, editable.
- `compute_per_mau_year`: Derived: Pinterest cost of revenue is 1.36 per MAU-year and Reddit 1.60 per DAU-year (both include hosting, ops staff and fees); Snap infrastructure alone is 3.40 per DAU-year. The typical value nets out storage and egress, which this model counts separately.
- `growth_default`: Used only for a visitor who has not said. Early-stage forecasts run far higher (Equidam finds founders forecast 120% in year one); an app with users already is held to a modest figure on purpose.
- `growth_decay`: Founders' own forecasts fall from 120% to 83% to 60% a year, about 0.7 each year. A doubling app is therefore about 9 times its size in year five, not 32.
- `migration_months`: Front-loaded: the share of custody gone by month m is 1 − (1 − m/M)², since the large lines (storage, compute, keys) move first and the long tail drains last. Twelve months realises two thirds of the first year's saving; twenty-four about 42% of the first and 92% of the second. Low is the slower migration, which is the smaller saving. No one-time integration cost is modelled.
- `posts_default`: The media-feed figure, used when the form says nothing about content.
- `mb_default`: The media-feed figure, used when the form says nothing about content.
- `kind_messaging_posts`: Chat is high volume and small.
- `kind_messaging_mb`: Text with the odd photo.
- `kind_messaging_egress_gb`: Text and thumbnails. Replaces egress_gb_per_mau_month when the kind is given.
- `kind_messaging_compute`: Fan-out and presence, little ranking. Replaces compute_per_mau_year when the kind is given.
- `kind_feed_posts`: Most users read; a few post.
- `kind_feed_mb`: Images and short video, kept. The research puts an image-heavy feed well above the 50 MB generic default.
- `kind_feed_egress_gb`: The research's 1 to 5 GB a month for an image-heavy feed. Replaces egress_gb_per_mau_month when the kind is given.
- `kind_feed_compute`: Ranking, recommendation and transcoding. Replaces compute_per_mau_year when the kind is given.
- `kind_community_posts`: Threads and replies.
- `kind_community_mb`: Mostly text, some attachments.
- `kind_community_egress_gb`: Threads with some images. Replaces egress_gb_per_mau_month when the kind is given.
- `kind_community_compute`: Search and notifications more than ranking. Replaces compute_per_mau_year when the kind is given.
- `kind_marketplace_posts`: Few posts, each a listing.
- `kind_marketplace_mb`: Listing photos add up.
- `kind_marketplace_egress_gb`: Listing photos browsed. Replaces egress_gb_per_mau_month when the kind is given.
- `kind_marketplace_compute`: Search, matching and payments plumbing. Replaces compute_per_mau_year when the kind is given.
- `team_factor_one`: A solo founder spends a fraction of the default hours on custody work. Applied to the default hours of every area the form leaves blank.
- `team_factor_ten`: The default bands were set with a small team in mind.
- `team_factor_fifty`: Several people on each area.
- `team_factor_more`: Whole teams on accounts, content and infrastructure.

## 1. Accounts and personal data

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default_hours_accounts` | Engineering hours a week on accounts, where the sliders start | 5 | 2 | 10 | hours per week | unsourced | none |
| `auth_per_mau_month` | Authentication as a service | 0.0046 | 0.0025 | 0.02 | USD per MAU per month | high | [Google Cloud Identity Platform pricing](https://cloud.google.com/identity-platform/pricing) (2026) |
| `reset_rate_per_mau_year` | Password resets per user | 0.25 | 0.1 | 0.5 | resets per MAU per year | unsourced | none |
| `reset_cost` | Cost of one password reset | 0.5 | 0.1 | 5 | USD per reset | low | [BleepingComputer, citing Forrester on helpdesk password resets](https://www.bleepingcomputer.com/news/security/the-true-cost-of-password-resets/) (2024-11) |
| `verify_price` | Identity or age verification | 1.5 | 0.8 | 1.89 | USD per check | high | [Stripe Identity pricing](https://stripe.com/identity) (2026) |
| `verify_share_uk` | Users needing a check per year, UK | 25% | 10% | 50% | ratio of MAU | unsourced | none |
| `verify_share_us` | Users needing a check per year, US | 10% | 2% | 30% | ratio of MAU | unsourced | none |
| `verify_share_eu` | Users needing a check per year, EU | 5% | 1% | 20% | ratio of MAU | unsourced | none |
| `verify_share_other` | Users needing a check per year, other | 2% | 0% | 10% | ratio of MAU | unsourced | none |
| `verify_remains_share` | Age checks that remain on Nostr | 10% | 0% | 50% | ratio | unsourced | none |
| `key_support_per_mau_year` | Supporting users who manage their own keys | 0.02 | 0.005 | 0.1 | USD per MAU per year | unsourced | none |

- `default_hours_accounts`: The form's bands (0, 1 to 10, 11 to 40, over 40) are read as 0, 5, 25 and 60 hours a week. The slider starts on the band nearest this; a results link that gives no band uses it directly.
- `auth_per_mau_month`: Identity Platform 100k to 1M tier. Low is its 10M-plus tier; high is Clerk beyond 50k.
- `reset_rate_per_mau_year`: No consumer-app source. Editable.
- `reset_cost`: Self-service email or SMS plus a share of support. The 70-dollar figure often cited from Forrester is for enterprise helpdesks and is not used.
- `verify_price`: Stripe Identity document plus selfie; Veriff 0.80 to 1.89 with monthly minimums.
- `verify_share_uk`: Online Safety Act age assurance applies to services likely to be accessed by children. Editable.
- `verify_share_us`: State app-store age laws (Utah, Texas) are in live litigation. Editable.
- `verify_share_eu`: Editable.
- `verify_share_other`: Editable.
- `verify_remains_share`: Nostr4's thesis, not a benchmark. Age assurance becomes an external layer the app reads rather than buys: the Texas and Utah laws put it at the app store, the EU is building a device-level age wallet under the DSA. The UK Online Safety Act is the residual: Ofcom's duty attaches to the service a child can use, wherever sign-up happened, so a client showing others' content may still have to check. Low is the ideal; high is the UK duty surviving in full.
- `key_support_per_mau_year`: Onboarding help, recovery guidance, signer integrations. What remains of the accounts line on Nostr.

## 2. Social graph and feeds

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default_hours_content` | Engineering hours a week on user content, feeds and the graph, where the sliders start | 10 | 4 | 25 | hours per week | unsourced | none |
| `db_gb_month` | Database storage | 0.23 | 0.115 | 0.345 | USD per GB-month | high | [AWS Price List API, Amazon RDS PostgreSQL gp3 us-east-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.csv) (2026-10) |
| `db_mb_per_mau` | Graph and profile metadata per user | 20 | 5 | 100 | MB per MAU | unsourced | none |
| `db_kb_per_post` | Metadata per post or message, retained twelve months | 2 | 1 | 5 | KB per post | unsourced | none |
| `feed_compute_share` | Share of that compute spent on feeds and recommendations | 40% | 30% | 50% | ratio | unsourced | none |
| `ranking_fee_per_mau_year` | A ranking or discovery provider | 0.05 | 0.01 | 0.25 | USD per MAU per year | unsourced | none |
| `graph_eng_remains_share` | Graph engineering that remains on Nostr | 30% | 20% | 50% | ratio | unsourced | none |

- `default_hours_content`: Same bands as above.
- `db_gb_month`: RDS PostgreSQL gp3 Multi-AZ. Low is single-AZ; high is Multi-AZ with readable standbys. Compute instances are extra and not modelled here.
- `db_mb_per_mau`: Follows, profile, indexes and counters. Editable.
- `db_kb_per_post`: Row plus indexes, not the media. Retention of twelve months is a model constant.
- `feed_compute_share`: The rest is serving. Editable.
- `ranking_fee_per_mau_year`: Web-of-trust ranking as a service. No public price list exists yet, including ours.
- `graph_eng_remains_share`: Assembling feeds from relays on the client.

## 3. Compute and storage

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default_hours_infra` | Engineering hours a week on infrastructure and storage, where the sliders start | 10 | 4 | 25 | hours per week | unsourced | none |
| `blob_gb_month` | Object storage | 0.023 | 0.00695 | 0.026 | USD per GB-month | high | [AWS Price List API, Amazon S3 us-east-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.csv) (2026-10) |
| `egress_gb` | Egress to the internet | 0.09 | 0 | 0.12 | USD per GB | high | [AWS Price List API, data transfer out to the internet](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/index.csv) (2026-06) |
| `egress_gb_per_mau_month` | Egress per active user | 1 | 0.3 | 5 | GB per MAU per month | unsourced | [Ericsson Mobility Report key figures (22 GB per smartphone per month, all apps)](https://www.ericsson.com/en/reports-and-papers/mobility-report/key-figures) (2025) |
| `relay_cost_year` | Running one relay of your own | 3,600 | 600 | 12,000 | USD per year | low | [Third-party estimates of Bluesky relay and PDS hosting cost](https://bsky.app) (2026) |
| `media_sponsor_share` | Media hosting an app still sponsors after moving to Nostr | 25% | 10% | 50% | ratio | unsourced | none |
| `cache_per_mau_year` | A thin cache in front of relays | 0.05 | 0.02 | 0.2 | USD per MAU per year | unsourced | none |

- `default_hours_infra`: Same bands as above.
- `blob_gb_month`: S3 Standard first 50 TB. Low is Backblaze B2; high is GCS multi-region.
- `egress_gb`: AWS first 10 TB. Low is Cloudflare R2 (zero); high is Google Cloud.
- `egress_gb_per_mau_month`: No platform publishes bytes served per user. The only proxy is 22 GB per smartphone per month across all apps.
- `relay_cost_year`: Third-party hosting estimates for a Bluesky relay or PDS run 30 to 512 per month. A Nostr relay with AUTH and rate limits sits in the same band.
- `media_sponsor_share`: Blossom or similar: users can host their own media, apps often still pay for some of it.
- `cache_per_mau_year`: What a Nostr app still serves itself.

## 4. Compliance and liability

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default_hours_legal` | Engineering hours a week on legal and compliance work, where the sliders start | 2 | 0 | 5 | hours per week | unsourced | none |
| `gdpr_program_year` | GDPR program for a small app (EU or UK) | 30,000 | 10,000 | 50,000 | USD per year | low | [Legiscope: GDPR compliance cost ranges for SMEs (vendor estimate)](https://legiscope.com/blog/gdpr-compliance-cost) (2026) |
| `uk_osa_year` | UK Online Safety Act, small or micro service | 11,000 | 3,000 | 65,000 | USD per year | medium | [DSIT Online Safety Act enactment impact assessment, tables 49 to 52](https://assets.publishing.service.gov.uk/media/6716222b9242eecc6c849b09/Online_Safety_act_enactment_impact_assessment.pdf) (2024-10) |
| `dsa_year` | EU Digital Services Act, non-VLOP platform | 5,000 | 1,500 | 20,000 | USD per year | unsourced | [ACT position paper citing the Commission's DSA notice-and-action setup floor](https://www.acte.be/) (2021) |
| `content_law_remains_share` | Content-law programs that remain on Nostr | 50% | 25% | 100% | ratio | unsourced | none |
| `us_privacy_year_small` | US privacy program, below the CCPA threshold | 3,000 | 1,000 | 10,000 | USD per year | unsourced | none |
| `us_privacy_year_large` | US privacy program, at or above the CCPA threshold | 15,000 | 5,000 | 50,000 | USD per year | unsourced | none |
| `ccpa_consumer_threshold` | CCPA consumer threshold | 100,000 | 100,000 | 100,000 | consumers | high | [California Attorney General: CCPA thresholds](https://oag.ca.gov/privacy/ccpa) (2026) |
| `dsar_rate_per_mau_year` | Data subject access requests per user | 0.0032 | 0.001 | 0.01 | requests per MAU per year | low | [DataGrail citing Gartner 2023 Market Guide: cost per manually handled DSAR](https://www.datagrail.io/blog/data-privacy/dsar-cost/) (2023) |
| `dsar_cost` | Cost of handling one request | 300 | 50 | 1,524 | USD per request | low | [DataGrail citing Gartner 2023 Market Guide: cost per manually handled DSAR](https://www.datagrail.io/blog/data-privacy/dsar-cost/) (2023) |
| `cyber_insurance_year` | Cyber liability insurance, small business | 1,552 | 1,200 | 7,000 | USD per year | medium | [Insureon: cyber liability insurance cost for small businesses](https://www.insureon.com/small-business-insurance/cyber-liability/cost) (2026-04) |
| `breach_prob_year` | Probability of a breach in a year | 5% | 2% | 15% | ratio | unsourced | none |
| `breach_cost_per_user` | Breach cost per affected user | 20 | 5 | 150 | USD per user | unsourced | [IBM Cost of a Data Breach Report 2026: global average](https://www.ibm.com/reports/data-breach) (2026) |
| `breach_cost_cap` | Breach cost cap | 4,990,000 | 4,990,000 | 11,500,000 | USD | high | [IBM Cost of a Data Breach Report 2026: global average](https://www.ibm.com/reports/data-breach) (2026) |
| `privacy_remains_share` | Privacy program that remains on Nostr | 30% | 20% | 50% | ratio | unsourced | none |
| `insurance_remains_share` | Insurance that remains on Nostr | 50% | 30% | 80% | ratio | unsourced | none |
| `retained_data_share` | Personal data an app still holds on Nostr | 10% | 5% | 30% | ratio | unsourced | none |

- `default_hours_legal`: Deletion flows, export tooling, retention jobs. Same bands as above.
- `gdpr_program_year`: Vendor ranges: micro 5k to 15k EUR, small 15k to 50k. Outsourced DPO alone runs 1,500 to 8,000 per month.
- `uk_osa_year`: Impact assessment, 2019 prices: ongoing 6,040 GBP with moderation and risk assessment, plus 7,460 GBP transition spread over three years; low is the 87 GBP basic case; high is a small high-risk service at 50,800 GBP. Converted at 1.30 USD per GBP.
- `dsa_year`: Point of contact, legal representative outside the EU, notice-and-action, statements of reasons. The only published floor is the Commission's 1,500 EUR setup estimate.
- `content_law_remains_share`: Nostr4's thesis, not a benchmark. The DSA's notice-and-action duties fall on hosting services, and a client that hosts nothing is a weaker target than a platform; the UK Online Safety Act still reaches a service a child can use. High keeps both programs whole.
- `us_privacy_year_small`: Policy, COPPA posture, basic counsel.
- `us_privacy_year_large`: Counsel, opt-out mechanisms, state-law tracking.
- `ccpa_consumer_threshold`: The law applies above 25M USD revenue, or 100k California consumers, or 50% of revenue from selling personal information. The model uses MAU as the proxy for consumers.
- `dsar_rate_per_mau_year`: 3.2 per thousand customers, attributed to DLA Piper.
- `dsar_cost`: Gartner's 1,524 is for a manually handled request; automated export is far cheaper.
- `cyber_insurance_year`: Median of policies sold. Scales with data held.
- `breach_prob_year`: No per-firm annual figure is published. Hiscox reports 59% of SMEs saw an attack in twelve months, which is not a breach rate.
- `breach_cost_per_user`: IBM stopped publishing a per-record figure; earlier editions ran around 150 to 165 per record for large organisations. The typical value is deliberately far below that.
- `breach_cost_cap`: The 2026 global mean. High is the US mean reported from the same edition. Expected loss is never scaled above it.
- `privacy_remains_share`: For whatever the app still retains privately.
- `insurance_remains_share`: Editable.
- `retained_data_share`: Scales the expected breach loss.

## 5. Moderation

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ts_base_salary` | Trust and safety analyst, base salary | 85,000 | 70,480 | 101,409 | USD per year | low | [Payscale: Trust and Safety Analyst salary](https://www.payscale.com/research/US/Job=Trust_and_Safety_Analyst/Salary) (2025-03) |
| `moderator_base_salary` | In-house content moderator, base salary | 42,500 | 38,000 | 55,000 | USD per year | low | [Payscale: Content Moderator hourly rate](https://www.payscale.com/research/US/Job=Content_Moderator/Hourly_Rate) (2025-07) |
| `moderator_seat_outsourced` | Outsourced moderation seat, all-in | 16,000 | 12,000 | 32,000 | USD per seat per year | low | [365outsource: content moderation outsourcing rates](https://365outsource.com/content-moderation-services/) (2026) |
| `mods_per_million_mau` | Moderators per million monthly users | 5 | 3 | 15 | people per 1M MAU | high | [Snap DSA transparency report H2 2025 (human resources and AMAR files)](https://values.snap.com/privacy/transparency/european-union-h2-2025) (2026-04) |
| `ts_tooling_per_mau_year` | Moderation tooling | 0.05 | 0.01 | 0.2 | USD per MAU per year | unsourced | none |
| `tooling_remains_share` | Moderation tooling that remains on Nostr | 20% | 10% | 50% | ratio | unsourced | none |
| `label_provider_per_mau_year` | A label or web-of-trust provider | 0.01 | 0.005 | 0.05 | USD per MAU per year | unsourced | none |
| `appeals_share` | Appeals and escalation on top of review labour | 10% | 5% | 20% | ratio | unsourced | none |
| `moderation_remains_share` | Moderation that remains on Nostr | 10% | 5% | 40% | ratio | unsourced | none |
| `mod_heads_default` | Reviewers, when the form names a team or a vendor but not how many | 3 | 1 | 15 | people | unsourced | none |

- `ts_base_salary`: Payscale median 70,480; Glassdoor average 101,409 (small samples, self-reported).
- `moderator_base_salary`: Payscale median 20.44 per hour over 2,080 hours.
- `moderator_seat_outsourced`: Offshore list price about 8 per hour over 2,000 hours; US BPO 15 to 25 per hour. List prices, not contracts.
- `mods_per_million_mau`: From DSA transparency reports: LinkedIn about 3, Pinterest at most 5, Snap about 15 per million EU users. Used when the form gives no reviewers at all.
- `ts_tooling_per_mau_year`: Classifiers, queues, hash matching. Vendor pricing is per item and unpublished at small scale.
- `tooling_remains_share`: Nostr4's thesis, not a benchmark. Classifiers, queues and hash matching give way to label providers and web of trust; what remains is hash matching on anything the app itself hosts.
- `label_provider_per_mau_year`: Labels and trust scores as a service, the moderation line's Nostr-native cost. No public price list exists yet, including ours.
- `appeals_share`: Editable.
- `moderation_remains_share`: Nostr4's thesis, not a benchmark. Review and ranking move to the network: web-of-trust weighting, interoperable algorithm configs and label events let users curate what they see, so an app that hosts nothing moderates nothing of 'its own'. What remains is illegal-content handling for any relay or media host the app runs, and app-store filter, report and block rules, which are engineering rather than labour.
- `mod_heads_default`: The 'up to 5' band's figure.

## 6. Payments

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `apple_rate_standard` | Apple App Store commission, standard | 30% | 26% | 30% | ratio of in-app revenue | high | [Apple App Store Small Business Program](https://developer.apple.com/app-store/small-business-program/) (2026) |
| `apple_rate_small` | Apple App Store commission, Small Business Program | 15% | 15% | 15% | ratio of in-app revenue | high | [Apple App Store Small Business Program](https://developer.apple.com/app-store/small-business-program/) (2026) |
| `google_rate_standard` | Google Play commission above 1M USD | 25% | 20% | 30% | ratio of in-app revenue | high | [Google Play service fees (US, UK and EEA from 2026-06-30; other markets)](https://support.google.com/googleplay/android-developer/answer/112622) (2026-06) |
| `google_rate_small` | Google Play commission on the first 1M USD | 15% | 10% | 15% | ratio of in-app revenue | high | [Google Play service fees (US, UK and EEA from 2026-06-30; other markets)](https://support.google.com/googleplay/android-developer/answer/112622) (2026-06) |
| `store_small_threshold` | Small-business threshold for store tiers | 1,000,000 | 1,000,000 | 1,000,000 | USD per year | high | [Apple App Store Small Business Program](https://developer.apple.com/app-store/small-business-program/) (2026) |
| `processor_rate` | Card processor rate | 2.9% | 1.5% | 3.5% | ratio of web revenue | high | [Stripe pricing (US)](https://stripe.com/pricing) (2026) |
| `processor_fixed` | Card processor fixed fee | 0.3 | 0.2 | 0.49 | USD per transaction | high | [Stripe pricing (US)](https://stripe.com/pricing) (2026) |
| `reseller_rate` | Merchant-of-record rate | 5% | 5% | 8% | ratio of reseller revenue | medium | [Paddle pricing (merchant of record)](https://www.paddle.com/pricing) (2026) |
| `reseller_fixed` | Merchant-of-record fixed fee | 0.5 | 0.5 | 0.5 | USD per transaction | medium | [Paddle pricing (merchant of record)](https://www.paddle.com/pricing) (2026) |
| `avg_ticket` | Average transaction size | 10 | 30 | 5 | USD | unsourced | none |
| `lightning_rate` | Lightning or on-chain processor rate | 1% | 0% | 1% | ratio of revenue | high | [OpenNode pricing and fees](http://help.opennode.com/en/articles/3176293-pricing-and-fees) (2026) |
| `mt_avoidance_year` | Legal work to stay out of money-transmitter status | 10,000 | 2,000 | 50,000 | USD per year | unsourced | none |
| `mt_remains_share` | Of that legal work, what remains on Nostr | 20% | 10% | 50% | ratio | unsourced | none |

- `apple_rate_standard`: 30% worldwide; 26% under the EU terms effective 2026-10-01. Subscriptions drop to 15% after the first year, not modelled.
- `apple_rate_small`: Under 1M USD of prior-year proceeds.
- `google_rate_standard`: US, UK and EEA from 2026-06-30: 20% new installs or 25% existing, plus 5% if Play Billing is used. Other markets 30%.
- `google_rate_small`: 10% service fee plus 5% billing fee in the US, UK and EEA; 15% elsewhere.
- `store_small_threshold`: Both stores step at 1M USD a year.
- `processor_rate`: Stripe US 2.9%; low is Stripe UK domestic cards 1.5%; high is PayPal Checkout 3.49%.
- `processor_fixed`: Stripe 0.30; UK 20p; PayPal 0.49.
- `reseller_rate`: Paddle and Lemon Squeezy list 5% plus a fixed fee; the reseller is the seller and carries sales tax and VAT.
- `reseller_fixed`: Per checkout.
- `avg_ticket`: Turns revenue into a transaction count for the fixed fee. A bigger ticket means fewer fees, so low is the larger ticket.
- `lightning_rate`: OpenNode about 1%; BTCPay Server 0%.
- `mt_avoidance_year`: Counsel and structuring for in-app balances or payouts. Charged only when the app holds user balances, credits or wallets.
- `mt_remains_share`: An app that never holds funds has far less exposure.

## Provenance

The research these numbers were taken from, including the figures that were looked for and not found, is kept
in the site repository under `tools/calculator/`. Changing a number means a new version of this file and of the
JSON beside it; results links carry the version they were made with.
