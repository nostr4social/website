# Non-Custodial Savings Calculator: assumptions, version 3

Dated 2026-10-27. Currency USD; sterling converted at 1.3 USD per GBP where a source is in pounds.

Every number the calculator uses is listed here with its source. Each has a **typical** value, which the
page shows as the headline, and a **low** and **high** value. Any value can be overridden on the page or in a
results link with `a.<key>=<value>`; the machine-readable form of this document is `assumptions.v3.json` beside it.

The range beside every figure on the page comes from the first section alone, **At scale: Nostr4's thesis**:
the time for Nostr to establish the standards and infrastructure that support Nostr at scale, the share of
each cost that remains once an app hosts nothing of its own, and the Nostr-native fees that take its place.
Only those rows take their low or high value in the low and high cases; every assumption on the custodial
side is held at its typical value in all three, because that half of the model is the prospect's to override.
The band is therefore a statement about the thesis, not about cloud pricing. **Low means the smaller saving**:
the thesis holding less well. The low and high beside the other rows are reference points, not scenarios.

The projection runs on a calendar, not a stopwatch: month 1 is January 2027 for every app, and
later versions of this file will shorten the time to scale as the network matures. The ramp starts from what
the network delivers today (`scale_progress_today`). An app's own integration, its time and its cost, is not
estimated here: it is settled case by case, in a consult. Results links carry the version they were made with;
earlier versions stay published beside this one.

Confidence means:

- **high**: read on the cited page or price list
- **medium**: derived from a primary source, or a primary figure converted or amortised
- **low**: a vendor page, a self-reported salary site, or a primary figure relayed second-hand
- **unsourced**: no public figure exists; a stated default, deliberately conservative

23 high, 68 unsourced, 10 low, 7 medium of 108 in all, of which 23 are the thesis and move the band. The unsourced ones are the model's weakest points; an unsourced value says why in its note.

## At scale: Nostr4's thesis

These are not estimates of the world as it is but of the world Nostr4 is building. No public price list
exists for the Nostr-native services, including ours, and at scale there is no vendor to lock an app in, so
their prices are what the market will bear. Treat the range, not the typical value, as the claim.

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `scale_progress_today` | Share of the at-scale saving the network already delivers to an app integrated today | 30% | 15% | 45% | ratio | unsourced | none |
| `p2p_store_fee_remains_share` | Share of the store commission that still applies to in-app payments once they are peer to peer on the network | 50% | 100% | 10% | ratio | unsourced | [CNBC: a Nostr client given 14 days over tips outside in-app purchase (the precedent, not a figure)](https://www.cnbc.com/2023/06/13/jack-dorseys-damus-may-be-thwarted-by-apples-strict-payment-rules.html) (2023-06) |
| `scale_months` | Months until Nostr is at scale: standards and infrastructure in place | 36 | 48 | 24 | months | unsourced | none |
| `media_sponsor_share` | Media hosting an app still sponsors after moving to Nostr | 25% | 50% | 10% | ratio | unsourced | none |
| `cache_per_mau_year` | A thin cache in front of relays | 0.05 | 0.2 | 0.02 | USD per MAU per year | unsourced | none |
| `verify_remains_share` | Age checks that remain on Nostr | 10% | 50% | 0% | ratio | unsourced | none |
| `key_handoff_live_share` | Share of key hand-offs that reach a live support contact rather than self-service | 2% | 10% | 0% | ratio | unsourced | none |
| `ranking_fee_per_mau_year` | A ranking or discovery provider | 0.05 | 0.25 | 0.01 | USD per MAU per year | unsourced | none |
| `graph_eng_remains_share` | Graph engineering that remains on Nostr | 30% | 50% | 20% | ratio | unsourced | none |
| `content_law_remains_share` | Content-law programs that remain on Nostr | 50% | 75% | 25% | ratio | unsourced | none |
| `privacy_remains_share` | Privacy program that remains on Nostr | 30% | 50% | 20% | ratio | unsourced | none |
| `insurance_remains_share` | Insurance that remains on Nostr | 50% | 80% | 30% | ratio | unsourced | none |
| `retained_data_share` | Personal data an app still holds on Nostr | 10% | 30% | 5% | ratio | unsourced | none |
| `tooling_remains_share` | Moderation tooling that remains on Nostr | 20% | 50% | 10% | ratio | unsourced | none |
| `label_provider_per_mau_year` | A label or web-of-trust provider | 0.01 | 0.05 | 0.005 | USD per MAU per year | unsourced | none |
| `moderation_remains_share` | Moderation that remains on Nostr | 10% | 50% | 5% | ratio | unsourced | none |
| `lightning_rate` | Lightning or on-chain processor rate | 1% | 1% | 0% | ratio of revenue | high | [OpenNode pricing and fees](http://help.opennode.com/en/articles/3176293-pricing-and-fees) (2026) |
| `mt_remains_share` | Of that legal work, what remains on Nostr | 20% | 50% | 10% | ratio | unsourced | none |
| `accounts_eng_remains_share` | Accounts engineering that remains on Nostr | 35% | 50% | 20% | ratio | unsourced | none |
| `infra_eng_remains_share` | Infrastructure engineering that remains on Nostr | 35% | 50% | 20% | ratio | unsourced | none |
| `relay_per_mau_year` | Relay capacity rented for a user, per active user | 0.14 | 0.25 | 0.05 | USD per MAU per year | low | [OpenSats: Advancements in Nostr Relays (relay.tools hosting at 12,000 sats a month; strfry on a small VPS)](https://opensats.org/blog/advancements-in-nostr-relays) (2026-03) |
| `relay_sponsored_share` | Share of users whose relay capacity the app sponsors, the rest bringing their own | 50% | 100% | 25% | ratio | unsourced | none |
| `relay_floor_year` | Relay capacity rented, the least an app pays | 600 | 1,200 | 240 | USD per year | low | [OpenSats: Advancements in Nostr Relays](https://opensats.org/blog/advancements-in-nostr-relays) (2026-03) |

- `scale_progress_today`: What an app integrated today already gets: keys, signed events, relays and follows carry most of the custodial cost and work now. User-paid providers, a media market, label and ranking providers and payment conversion are the rest. The ramp runs from here.
- `p2p_store_fee_remains_share`: In our reading, an app on Nostr is not a party to the payment, so a store's in-app-purchase rule should not reach it. Some app-store vendors have read it otherwise: in June 2023 one told a Nostr client that tips associated with receiving content from creators through a mechanism other than in-app purchase broke its payment guideline, and gave the app 14 days to comply (CNBC, June 2023). Precedent pending as of October 2026. The low case keeps the whole commission; the high case treats the precedent as settled.
- `scale_months`: Nostr4's estimate of the time for the network to establish the standards and infrastructure that support Nostr at scale; user growth carries the rest. The ramp starts at scale_progress_today and is front-loaded: the share of the at-scale saving the network delivers in month m is p + (1 − p)(1 − (1 − m/M)²), because the standards already adopted (keys, signed events, relays, follows) carry the bulk of custodial cost (accounts, graph, storage) and deliver early, while the pieces still maturing (user-paid providers, a media market, label and ranking providers, payment conversion) are the tail. A calendar, not a stopwatch: month 1 is January of start_year for every app, and later versions of this file will shorten the time to scale as the network matures. An app's own integration, its time and its cost, is not estimated here: it is settled case by case, in a consult.
- `media_sponsor_share`: Blossom or similar: users can host their own media, apps often still pay for some of it.
- `cache_per_mau_year`: A thin cache in front of relays, what a Nostr app still serves itself. What the market will bear: no public price list exists, including ours, and at scale there is no vendor to lock an app in.
- `verify_remains_share`: Age assurance becomes an external layer the app reads rather than buys: as we read them in October 2026, the Texas and Utah laws put it at the app-store, and the EU is building a device-level age wallet under the DSA. The UK Online Safety Act is the residual: in our reading the duty attaches to the service a child can use, wherever sign-up happened, so a client showing others' content may still have to check. Low keeps the UK duty in full; high is the ideal.
- `key_handoff_live_share`: A key cannot be reset by the app. A non-custodial app's support is a redirect to the user's own or a recommended key-management service; only a share of those redirects reach a person. The contact costs are Gartner's.
- `ranking_fee_per_mau_year`: Web-of-trust ranking or discovery as a service. What the market will bear: no public price list exists, including ours, and at scale there is no vendor to lock an app in.
- `graph_eng_remains_share`: At scale, assembling feeds from relays on the client is the app's own feed logic.
- `content_law_remains_share`: In our reading, as of October 2026, the DSA's notice-and-action duties fall on hosting services, and a client that hosts nothing is a weaker target than a platform; the UK Online Safety Act still reaches a service a child can use. Low keeps three quarters of both programs, the same world as moderation's low case: the duties follow whatever the app still hosts.
- `privacy_remains_share`: For whatever the app still retains privately.
- `insurance_remains_share`: A policy sized to the data still held.
- `retained_data_share`: Personal data an app still holds on Nostr: scales the expected breach loss and the access requests that remain.
- `tooling_remains_share`: Classifiers, queues and hash matching give way to label providers and web of trust; what remains is hash matching on anything the app itself hosts.
- `label_provider_per_mau_year`: Labels and trust scores as a service, the moderation line's Nostr-native cost. What the market will bear: no public price list exists, including ours, and at scale there is no vendor to lock an app in.
- `moderation_remains_share`: Review and ranking move to the network: web-of-trust weighting, interoperable algorithm configs and label events let users curate what they see, so, in our reading, an app that hosts nothing moderates nothing of its own. What remains is illegal-content handling for any relay or media host the app runs, the defaults a new user starts with, and the default filter and the report and block controls the app-stores require. Low keeps half, the same world as the content-law low case.
- `lightning_rate`: OpenNode about 1%; BTCPay Server 0%. The at-scale saving is full conversion of in-app payments to peer-to-peer rails (bitcoin, stablecoins); store rails are unchanged on both sides. As of October 2026 some app-stores' rules still restrict bypassing in-app purchase for digital goods inside the app in some regions, and on-ramp costs are borne by users: they affect conversion, not the app's P&L.
- `mt_remains_share`: An app that never holds funds has far less exposure.
- `accounts_eng_remains_share`: At scale a Nostr app still builds and keeps signer login, the key hand-off and session handling. Zero remaining is not defensible.
- `infra_eng_remains_share`: At scale, relay connection management, caching, media handling and the relay capacity the app rents still need engineering time.
- `relay_per_mau_year`: No operator publishes cost per user. Typical is the sourced operator figure: a thousand active users per vCPU and 2 GB, about 12 USD a month on a European VPS, which is 0.14 a user a year. Low is the same capacity with backups and monitoring; high is the strfry-efficiency claim. Applied to the share of users the app sponsors (relay_sponsored_share), rented from a provider who carries the hosting duties.
- `relay_sponsored_share`: Users who bring their own relay cost the app nothing. The app sponsors capacity for the rest, rented from a provider who, in our reading, carries the hosting duties. What that sponsorship earns as a premium or sponsored add-on is not modelled.
- `relay_floor_year`: The least an app pays however few its users: one managed relay with backups, about 50 a month. The per-user rate takes over above about 4,300 sponsored users, about 8,600 active users at the typical sponsored share.

## Used by more than one line

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `eng_base_salary` | Backend or infra engineer, base salary | 135,980 | 110,000 | 180,000 | USD per year | high | [BLS Occupational Outlook: software developers, median annual wage](https://www.bls.gov/ooh/computer-and-information-technology/software-developers.htm) (2025-05) |
| `loaded_multiplier` | Benefits multiplier on base salary | 1.43× | 1.3× | 1.6× | multiplier | high | [BLS Employer Costs for Employee Compensation, private industry](https://www.bls.gov/news.release/ecec.nr0.htm) (2026-06) |
| `overhead_multiplier` | Overhead multiplier (equipment, office, software) | 1.15× | 1.05× | 1.25× | multiplier | unsourced | none |
| `compute_per_mau_year` | Serving and feed compute per active user | 1 | 0.5 | 3 | USD per MAU per year | medium | [Pinterest FY2025 Form 10-K: cost of revenue and MAU](https://www.sec.gov/Archives/edgar/data/1506293/000150629326000021/pins-20251231.htm) (2026-02) |
| `growth_default` | User growth over the next year, when not given | 0% | 0% | 0% | ratio of today's users | unsourced | none |
| `growth_decay` | Each year's growth rate as a share of the previous year's | 75% | 50% | 100% | ratio | low | [Equidam: benchmarks for startup revenue growth (15,000+ ventures)](https://www.equidam.com/benchmarks-for-startup-revenue-growth) (2024) |
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
| `jur_weight_us` | Weight of the US among the regions chosen | 254 | 254 | 254 | millions of social media users | high | [DataReportal Digital 2026: the United States of America (social media user identities, October 2025)](https://datareportal.com/reports/digital-2026-united-states-of-america) (2026-02) |
| `jur_weight_uk` | Weight of the UK among the regions chosen | 55.5 | 55.5 | 55.5 | millions of social media users | high | [DataReportal Digital 2026: the United Kingdom (social media user identities, October 2025)](https://datareportal.com/reports/digital-2026-united-kingdom) (2026-02) |
| `jur_weight_eu` | Weight of the EU among the regions chosen | 230 | 230 | 230 | millions of social media users | medium | [Eurostat: digital economy and society statistics, households and individuals (67% of those aged 16 to 74 used social networks in 2025)](https://ec.europa.eu/eurostat/statistics-explained/index.php?title=Digital_economy_and_society_statistics_-_households_and_individuals) (2026) |
| `jur_weight_other` | Weight of other regions among the regions chosen | 254 | 254 | 254 | millions of social media users | unsourced | none |

- `eng_base_salary`: US median for software developers. Infra specialists run higher; the median is the defensible default.
- `loaded_multiplier`: Private-industry total compensation divided by wages: benefits are 30% of compensation.
- `overhead_multiplier`: ECEC excludes non-compensation overhead. A conservative allowance, editable.
- `compute_per_mau_year`: Derived: Pinterest cost of revenue is 1.36 per MAU-year and Reddit 1.60 per DAU-year (both include hosting, ops staff and fees); Snap infrastructure alone is 3.40 per DAU-year. The typical value nets out storage and egress, which this model counts separately.
- `growth_default`: Used only for a visitor who has not said. An app that gives no growth figure is held flat, so the projection claims nothing about its growth; the growth question on the form is the way to say otherwise.
- `growth_decay`: Founders' own forecasts fall from 120% to 83% to 60% a year, about 0.7 each year. A doubling app is therefore about 9 times its size in year five, not 32.
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
- `jur_weight_us`: The form asks which regions an app has users in, not how many in each. Each chosen region is weighted by its social media users, so an app in the US and the UK is read as 82% US. Overridable until the form asks for the split.
- `jur_weight_uk`: As above.
- `jur_weight_eu`: Derived: about 340 million EU residents aged 16 to 74 (Eurostat, 1 January 2025) at 67% is about 230 million.
- `jur_weight_other`: Set equal to the US on purpose: an app that names other regions is assumed to have as many users there as in the US, since the rest of the world is too large to weight by its size. Overridable.

## 1. Accounts and personal data

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default_hours_accounts` | Engineering hours a week on accounts, where the sliders start | 5 | 2 | 10 | hours per week | unsourced | none |
| `auth_per_mau_month` | Authentication as a service | 0.0046 | 0.0025 | 0.02 | USD per MAU per month | high | [Google Cloud Identity Platform pricing](https://cloud.google.com/identity-platform/pricing) (2026) |
| `reset_rate_per_mau_year` | Password resets per user | 0.25 | 0.1 | 0.5 | resets per MAU per year | unsourced | none |
| `reset_cost` | Cost of one password reset | 0.5 | 0.1 | 5 | USD per reset | low | [BleepingComputer, citing Forrester on helpdesk password resets](https://www.bleepingcomputer.com/news/security/the-true-cost-of-password-resets/) (2024-11) |
| `support_self_service_contact` | Cost of a self-service support contact | 0.1 | 0.1 | 0.25 | USD per contact | high | [Gartner, 2019 Customer Service and Support Leader poll](https://www.gartner.com/en/newsroom/press-releases/2019-09-25-gartner-says-only-9--of-customers-report-solving-thei) (2019-09) |
| `support_live_contact` | Cost of a live support contact | 8.01 | 8.01 | 12 | USD per contact | high | [Gartner, 2019 Customer Service and Support Leader poll](https://www.gartner.com/en/newsroom/press-releases/2019-09-25-gartner-says-only-9--of-customers-report-solving-thei) (2019-09) |
| `verify_price` | Identity or age verification | 1.5 | 0.8 | 1.89 | USD per check | high | [Stripe Identity pricing](https://stripe.com/identity) (2026) |
| `verify_share_uk` | Users needing a check per year, UK | 25% | 10% | 50% | ratio of MAU | unsourced | none |
| `verify_share_us` | Users needing a check per year, US | 2% | 0% | 10% | ratio of MAU | low | [SCOTUSblog: Supreme Court allows Texas to enforce its app store age-verification law (SB 2420)](https://www.scotusblog.com/2026/07/supreme-court-allows-texas-to-enforce-law-requiring-age-verification-and-parental-consent-on-app/) (2026-07) |
| `verify_share_eu` | Users needing a check per year, EU | 5% | 1% | 20% | ratio of MAU | unsourced | none |
| `verify_share_other` | Users needing a check per year, other | 2% | 0% | 10% | ratio of MAU | unsourced | none |

- `default_hours_accounts`: The form's bands (0, 1 to 10, 11 to 40, over 40) are read as 0, 5, 25 and 60 hours a week. The slider starts on the band nearest this; a results link that gives no band uses it directly.
- `auth_per_mau_month`: Identity Platform 100k to 1M tier. Low is its 10M-plus tier; high is Clerk beyond 50k.
- `reset_rate_per_mau_year`: No consumer-app source. Editable.
- `reset_cost`: Self-service email or SMS plus a share of support. The 70-dollar figure often cited from Forrester is for enterprise helpdesks and is not used.
- `support_self_service_contact`: Gartner's 2019 poll: live channels 8.01 a contact, self-service about 0.10. Read when a key hand-off is served by a help page or a redirect rather than a person.
- `support_live_contact`: Gartner's 2019 poll: 8.01 a live contact (phone, chat, email); high is the upper end of 2025 benchmarks.
- `verify_price`: Stripe Identity document plus selfie; Veriff 0.80 to 1.89 with monthly minimums.
- `verify_share_uk`: Online Safety Act age assurance applies to services likely to be accessed by children. Editable.
- `verify_share_us`: Most US social apps run no paid identity check today: the large platforms use age estimation on accounts they suspect are under age and check documents only where a law requires it, and the Texas and Utah app-store laws, as we read them in October 2026, put the age signal at the store rather than in the app. The share is the users an app still sends to a paid check, not the users whose age it knows.
- `verify_share_eu`: Editable.
- `verify_share_other`: Editable.

## 2. Social graph and feeds

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default_hours_content` | Engineering hours a week on user content, feeds and the graph, where the sliders start | 10 | 4 | 25 | hours per week | unsourced | none |
| `db_gb_month` | Database storage | 0.23 | 0.115 | 0.345 | USD per GB-month | high | [AWS Price List API, Amazon RDS PostgreSQL gp3 us-east-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.csv) (2026-10) |
| `db_mb_per_mau` | Graph and profile metadata per user | 20 | 5 | 100 | MB per MAU | unsourced | none |
| `db_kb_per_post` | Metadata per post or message, retained twelve months | 2 | 1 | 5 | KB per post | unsourced | none |
| `feed_compute_share` | Share of that compute spent on feeds and recommendations | 40% | 30% | 50% | ratio | unsourced | none |

- `default_hours_content`: Same bands as above.
- `db_gb_month`: RDS PostgreSQL gp3 Multi-AZ. Low is single-AZ; high is Multi-AZ with readable standbys. Compute instances are extra and not modelled here.
- `db_mb_per_mau`: Follows, profile, indexes and counters. Editable.
- `db_kb_per_post`: Row plus indexes, not the media. Retention of twelve months is a model constant.
- `feed_compute_share`: The rest is serving. Editable.

## 3. Compute and storage

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default_hours_infra` | Engineering hours a week on infrastructure and storage, where the sliders start | 10 | 4 | 25 | hours per week | unsourced | none |
| `blob_gb_month` | Object storage | 0.023 | 0.00695 | 0.026 | USD per GB-month | high | [AWS Price List API, Amazon S3 us-east-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.csv) (2026-10) |
| `egress_gb` | Egress to the internet | 0.02 | 0 | 0.09 | USD per GB | high | [Amazon CloudFront pay-as-you-go pricing: data transfer out, United States and Europe](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/) (2026-10) |
| `egress_gb_per_mau_month` | Egress per active user | 1 | 0.3 | 5 | GB per MAU per month | unsourced | [Ericsson Mobility Report key figures (22 GB per smartphone per month, all apps)](https://www.ericsson.com/en/reports-and-papers/mobility-report/key-figures) (2025) |

- `default_hours_infra`: Same bands as above.
- `blob_gb_month`: S3 Standard first 50 TB. Low is Backblaze B2; high is GCS multi-region.
- `egress_gb`: Nobody serves media from origin. CloudFront steps from 0.085 (first 10 TB) to 0.030 (over 500 TB), 0.025 (over 1 PB) and 0.020 (over 5 PB); Bunny lists 0.01 standard and 0.005 to 0.003 on its volume tier; Cloudflare R2 egress is zero. The typical value is a large CDN at volume; the high is AWS direct to the internet for anyone still doing that.
- `egress_gb_per_mau_month`: No platform publishes bytes served per user. The only proxy is 22 GB per smartphone per month across all apps.

## 4. Compliance and liability

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default_hours_legal` | Engineering hours a week on legal and compliance work, where the sliders start | 2 | 0 | 5 | hours per week | unsourced | none |
| `gdpr_program_year` | GDPR program for a small app (EU or UK) | 30,000 | 10,000 | 50,000 | USD per year | low | [Legiscope: GDPR compliance cost ranges for SMEs (vendor estimate)](https://legiscope.com/blog/gdpr-compliance-cost) (2026) |
| `uk_osa_year` | UK Online Safety Act, small or micro service | 11,000 | 3,000 | 65,000 | USD per year | medium | [DSIT Online Safety Act enactment impact assessment, tables 49 to 52](https://assets.publishing.service.gov.uk/media/6716222b9242eecc6c849b09/Online_Safety_act_enactment_impact_assessment.pdf) (2024-10) |
| `dsa_year` | EU Digital Services Act, non-VLOP platform | 5,000 | 1,500 | 20,000 | USD per year | unsourced | [ACT position paper citing the Commission's DSA notice-and-action setup cost](https://www.acte.be/) (2021) |
| `us_privacy_year_small` | US privacy program, below the CCPA threshold | 3,000 | 1,000 | 10,000 | USD per year | unsourced | none |
| `us_privacy_year_large` | US privacy program, at or above the CCPA threshold | 15,000 | 5,000 | 50,000 | USD per year | unsourced | none |
| `ccpa_consumer_threshold` | CCPA consumer threshold | 100,000 | 100,000 | 100,000 | consumers | high | [California Attorney General: CCPA thresholds](https://oag.ca.gov/privacy/ccpa) (2026) |
| `annual_users_per_mau` | Annual unique users as a multiple of monthly actives | 2× | 1× | 3× | multiplier | unsourced | none |
| `dsar_rate_per_mau_year` | Data subject access requests per user | 0.0002 | 0.00005 | 0.001 | requests per MAU per year | low | [DataGrail 2025 Data Privacy Trends (webinar): 1,215 requests per 5 million monthly unique visitors in 2024](https://www.datagrail.io/resources/webinars/2025-data-privacy-trends-managing-rising-dsr-volumes-compliance-costs/) (2025) |
| `dsar_cost` | Cost of handling one request | 25 | 5 | 150 | USD per request | unsourced | none |
| `cyber_insurance_year` | Cyber liability insurance, small business | 1,552 | 1,200 | 7,000 | USD per year | medium | [Insureon: cyber liability insurance cost for small businesses](https://www.insureon.com/small-business-insurance/cyber-liability/cost) (2026-04) |
| `breach_prob_year` | Probability of a breach in a year | 5% | 2% | 10% | ratio | medium | [Cyentia Institute, IRIS 2025: annualized incident probability (Figure 6, Figure A2)](https://www.cyentia.com/wp-content/uploads/2026/03/IRIS-2025.pdf) (2026-03) |
| `breach_cost_per_user` | Breach cost per affected user | 20 | 5 | 150 | USD per user | unsourced | [IBM Cost of a Data Breach Report 2026: global average](https://www.ibm.com/reports/data-breach) (2026) |
| `breach_cost_cap` | Breach cost cap | 4,990,000 | 4,990,000 | 11,500,000 | USD | high | [IBM Cost of a Data Breach Report 2026: global average](https://www.ibm.com/reports/data-breach) (2026) |
| `ca_share_of_us_users` | Share of US users in California | 11.5% | 11.5% | 11.5% | ratio | high | [US Census Bureau QuickFacts: California and the United States, population estimates July 1, 2025](https://www.census.gov/quickfacts/fact/table/CA,US/PST045225) (2026) |

- `default_hours_legal`: Deletion flows, export tooling, retention jobs. Same bands as above.
- `gdpr_program_year`: Vendor ranges: micro 5k to 15k EUR, small 15k to 50k. Outsourced DPO alone runs 1,500 to 8,000 per month.
- `uk_osa_year`: Impact assessment, 2019 prices: ongoing 6,040 GBP with moderation and risk assessment, plus 7,460 GBP transition spread over three years; low is the 87 GBP basic case; high is a small high-risk service at 50,800 GBP. Converted at 1.30 USD per GBP.
- `dsa_year`: Point of contact, legal representative outside the EU, notice-and-action, statements of reasons. The only published figure is the Commission's 1,500 EUR setup estimate.
- `us_privacy_year_small`: Policy, COPPA posture, basic counsel.
- `us_privacy_year_large`: Counsel, opt-out mechanisms, state-law tracking.
- `ccpa_consumer_threshold`: The law applies above 25M USD revenue, or 100k California consumers or households, or 50% of revenue from selling personal information. Compared against US users × the California share.
- `annual_users_per_mau`: Used only to test the CCPA threshold, which counts consumers a year, not monthly actives. Access-request volume stays per monthly user.
- `dsar_rate_per_mau_year`: DataGrail's 2024 benchmark is about 0.00024 a visitor a year; its 2023 report put it at 859 per million identities (0.00086), which is the high. Its customers are companies that bought privacy tooling, so both figures lean high for a consumer app. The 3.2 per thousand figure attributed to DLA Piper is an enterprise, manual-handling number and is not used. Applied to EU and UK users always, and to US users only at or above the CCPA threshold.
- `dsar_cost`: Automated consumer export: a support touch plus an export job. Gartner's 1,524 a request (via DataGrail) is for an enterprise request handled by hand and is not used; the high is a quarter-hour of a privacy engineer plus review. On Nostr the requests fall with the data retained (retained_data_share), not to zero.
- `cyber_insurance_year`: Median of policies sold. Scales with data held.
- `breach_prob_year`: IRIS 2025 models a 9.3% chance that a typical firm has a significant incident in a year (2024), with firms under 10M revenue at 0.60× that (5.6%) and the information sector at 8.4%. Cross-check: a small-business cyber policy at 1,552 a year and the 2025 industry loss ratio of 53% (NAIC) imply insurers expect to pay out about 820 a year per small policy, far below this row's expected loss, because the row counts the whole loss and the policy pays only part of it. Shown as risk exposure, apart from the cash costs.
- `breach_cost_per_user`: IBM stopped publishing a per-record figure; earlier editions ran around 150 to 165 per record for large organisations. IRIS 2025 puts the median loss for a firm under 100M revenue at 357k. The typical value is deliberately far below the per-record figure.
- `breach_cost_cap`: The 2026 global mean. High is the US mean reported from the same edition. Expected loss is never scaled above it.
- `ca_share_of_us_users`: 39.36 million of 341.8 million. The CCPA threshold counts California consumers, so it is compared against the app's US users times this share, not against total MAU.

## 5. Moderation

| Key | What | Typical | Low | High | Unit | Confidence | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ts_base_salary` | Trust and safety analyst, base salary | 85,000 | 70,480 | 101,409 | USD per year | low | [Payscale: Trust and Safety Analyst salary](https://www.payscale.com/research/US/Job=Trust_and_Safety_Analyst/Salary) (2025-03) |
| `moderator_base_salary` | In-house content moderator, base salary | 42,500 | 38,000 | 55,000 | USD per year | low | [Payscale: Content Moderator hourly rate](https://www.payscale.com/research/US/Job=Content_Moderator/Hourly_Rate) (2025-07) |
| `moderator_seat_outsourced` | Outsourced moderation seat, all-in | 16,000 | 12,000 | 32,000 | USD per seat per year | low | [365outsource: content moderation outsourcing rates](https://365outsource.com/content-moderation-services/) (2026) |
| `mods_per_million_mau` | Moderators per million monthly users | 5 | 3 | 15 | people per 1M MAU | high | [Snap DSA transparency report H2 2025 (human resources and AMAR files)](https://values.snap.com/privacy/transparency/european-union-h2-2025) (2026-04) |
| `ts_tooling_per_mau_year` | Moderation tooling | 0.05 | 0.01 | 0.2 | USD per MAU per year | unsourced | none |
| `appeals_share` | Appeals and escalation on top of review labour | 10% | 5% | 20% | ratio | unsourced | none |
| `mod_heads_default` | Reviewers, when the form names a team or a vendor but not how many | 3 | 1 | 15 | people | unsourced | none |

- `ts_base_salary`: Payscale median 70,480; Glassdoor average 101,409 (small samples, self-reported).
- `moderator_base_salary`: Payscale median 20.44 per hour over 2,080 hours.
- `moderator_seat_outsourced`: Offshore list price about 8 per hour over 2,000 hours; US BPO 15 to 25 per hour. List prices, not contracts.
- `mods_per_million_mau`: From DSA transparency reports: LinkedIn about 3, Pinterest at most 5, Snap about 15 per million EU users. Used when the form gives no reviewers at all.
- `ts_tooling_per_mau_year`: Classifiers, queues, hash matching. Vendor pricing is per item and unpublished at small scale.
- `appeals_share`: Editable.
- `mod_heads_default`: The 'up to 5' band's figure.

## 6. Payments

The input this line reads, `rev`, is **in-app payments, gross monthly volume (USD)**: all payments the app
facilitates: purchases, subscriptions, tips and sales between users. The app's own take is a share of this, not a
separate input. The line measures the fee stack custody puts on that volume, not the revenue itself.

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
| `mt_avoidance_year` | Legal work on money-transmitter exposure | 10,000 | 2,000 | 50,000 | USD per year | unsourced | none |

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
- `mt_avoidance_year`: Counsel and structuring for in-app balances or payouts; the exposure, not an outcome. Charged only when the app holds user balances, credits or wallets.

## Provenance

The research these numbers were taken from, including the figures that were looked for and not found, is kept
in the site repository under `tools/calculator/`. Changing a number means a new version of this file and of the
JSON beside it; results links carry the version they were made with.
