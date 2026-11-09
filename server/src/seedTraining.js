import { prisma } from './db.js';

/**
 * Built-in starter curriculum for the training center. Original content.
 * Idempotent: a course is only created when no course with its slug exists,
 * so edits made by trainers in the admin panel are never overwritten.
 */
const COURSES = [
  {
    slug: 'dispatch-fundamentals',
    title: 'Dispatch Fundamentals',
    category: 'fundamentals',
    level: 'beginner',
    description: 'How freight moves, who does what, what carrier authority means, the main equipment types and how load boards fit in.',
    lessons: [
      {
        title: 'How freight moves: shippers, brokers, carriers and dispatchers',
        minutes: 12,
        content: `# How freight moves

Every load you will ever book starts with a **shipper** — a business that needs goods moved — and ends with a **receiver** (consignee). Between them sit three roles you will deal with every day.

## The players

- **Shipper / receiver.** Owns or receives the freight. Large shippers often contract directly with big carriers; much of the spot market flows through brokers.
- **Freight broker.** Holds broker authority, contracts with the shipper and hires a carrier to haul the load. The broker earns the difference between what the shipper pays and what the carrier is paid.
- **Motor carrier.** The trucking company — from a single owner-operator to a fleet of hundreds — that physically moves the freight under its own authority and insurance.
- **Dispatcher.** Works *for the carrier*. A dispatcher finds loads, negotiates rates, handles paperwork and keeps the truck moving so the driver can focus on driving.

## Where an independent dispatcher fits

Small carriers (1–10 trucks) rarely have time to search load boards, call brokers and chase paperwork while driving. An independent dispatcher handles that work for a percentage of each load's gross or a flat weekly fee. Your value is simple: **more paid miles, fewer empty miles, less admin for the owner.**

## Spot market vs. contract freight

- **Contract freight** is negotiated in advance at agreed lane rates, usually between shippers and established carriers.
- **Spot freight** is booked load-by-load at the current market price. Most small carriers and their dispatchers live in the spot market, primarily through load boards and broker relationships.

## A day in the life

1. Check where each truck will be empty and when.
2. Search for loads that fit equipment, hours of service and the driver's home-time needs.
3. Call brokers, negotiate, and confirm.
4. Send the carrier packet if it is a new broker, receive and review the rate confirmation.
5. Track pickup and delivery, handle detention and issues.
6. Collect paperwork (BOL/POD) so the carrier can invoice or factor.

> Keep your role clear: you represent the carrier. If you start arranging freight on behalf of shippers, you may be acting as a broker — see the compliance lesson in *Running Your Dispatch Business*.`,
      },
      {
        title: 'Carrier authority: USDOT and MC numbers explained',
        minutes: 12,
        content: `# Carrier authority

Before you dispatch a truck you must confirm the carrier is **legally allowed to haul the freight** you are booking.

## USDOT number

A USDOT number identifies a carrier to the Federal Motor Carrier Safety Administration (FMCSA). Carriers operating commercial vehicles in interstate commerce must have one, and some states require it for intrastate operations too. The USDOT record shows the company's legal name, address, fleet size (power units), drivers and operation classification.

## Operating authority (MC number)

For-hire carriers hauling regulated freight across state lines also need **operating authority**, historically identified by an MC (docket) number. Authority can be *active*, *inactive*, *pending*, *revoked* or *not authorized*. Only book interstate for-hire freight for carriers whose authority is **active**.

FMCSA has announced plans to consolidate identifiers under the USDOT number. Always **verify the current status directly in FMCSA's systems** rather than relying on an old screenshot or a lead list.

## What else must be on file

- **Insurance.** For-hire carriers of general freight must keep at least the federally required auto liability coverage on file with FMCSA. Many brokers require more than the minimum (commonly $1,000,000 auto liability and $100,000 cargo coverage) — check each broker's requirements.
- **BOC-3.** A designation of process agents filing, required for authority to become active.

## Authority age

New authorities go through a new-entrant period. Many brokers set a **minimum authority age** before they will onboard a carrier. When you prospect, note the authority date so you know which brokers will accept the carrier.

## How to check in DispatchDesk

Use **Find carriers** to search the FMCSA public census data by name, USDOT, MC, state and fleet size. Each record shows its source and when it was retrieved. Treat it as a starting point and re-verify authority and insurance before booking.`,
      },
      {
        title: 'Equipment types and what they haul',
        minutes: 10,
        content: `# Equipment types

Matching the right truck to the right freight is the core of dispatching. Learn the common trailer types and their limitations.

| Equipment | Typical freight | Things to watch |
|---|---|---|
| **Dry van** (usually 53 ft) | Palletized consumer goods, boxed freight | Most loads available, most competition |
| **Reefer** (refrigerated) | Food, produce, pharmaceuticals | Temperature settings, pre-cooling, continuous vs. cycle mode, fuel for the unit |
| **Flatbed** | Steel, lumber, building materials, machinery | Tarps, chains/straps, securement rules, oversize permits |
| **Step deck** | Taller machinery that cannot fit on a flatbed | Lower deck height, ramps |
| **Hotshot** (pickup + gooseneck) | Smaller, time-sensitive loads | Weight limits, shorter trailer length |
| **Power only** | Hauling a trailer provided by the shipper/broker | Correct hitch, trailer inspection at pickup |
| **Box truck** | Local and regional LTL-style freight, final mile | Liftgate, pallet jack, weight capacity |

## Questions to ask every carrier

1. Exact trailer length and type, and door type (swing or roll-up).
2. Maximum legal weight they can carry.
3. Special equipment: liftgate, pallet jack, load bars, straps, tarps, team drivers.
4. Endorsements: hazmat, TWIC, tanker.
5. Preferred lanes, home base and how often the driver wants to be home.

Record these on the carrier profile. Good notes let you search loads in seconds instead of calling the driver every time.

## Weight and dimensions

Legal weight and size limits vary by state and by axle configuration. Never promise a broker a weight the carrier has not confirmed, and plan routes for oversize freight only with the required permits.`,
      },
      {
        title: 'Load boards and the daily search routine',
        minutes: 11,
        content: `# Load boards

Load boards are marketplaces where brokers post available loads and carriers or their dispatchers search for them. Well-known paid boards include DAT, Truckstop and 123Loadboard. Each is a subscription service with its own terms — use them under your own or your carrier's account and never share logins.

## What a posting tells you

- Origin, destination and pickup date
- Equipment type, length and weight
- Posted rate (sometimes) and broker contact
- Broker credit and days-to-pay information (on boards that provide it)

A posted rate is the broker's opening position, not the final price.

## A repeatable search routine

1. **Start from where the truck will be empty.** Search a radius around that city (for example 50–100 miles) for the day the driver is available.
2. **Filter by equipment and weight** the carrier can legally haul.
3. **Sort by what matters:** rate per mile, deadhead, or the destination market you want to reach.
4. **Think two loads ahead.** A high-paying load into a dead market can cost more on the next leg. Check what freight leaves the destination area.
5. **Call fast.** Good loads move quickly; have your carrier's MC, equipment and availability ready before you dial.

## Paste load details into DispatchDesk

Copy a posting's text and paste it into **Loads → Parse load text**. The parser extracts origin, destination, dates, miles, weight and rate so you can calculate rate per mile and deadhead before you call. Always verify parsed fields against the original posting.

## Track your lanes

Every load you save builds **lane history** — what you were paid between two markets. Over time this becomes your own rate reference, based on real bookings instead of guesses.`,
      },
    ],
  },
  {
    slug: 'carrier-sales-cold-calling',
    title: 'Carrier Sales & Cold Calling',
    category: 'sales',
    level: 'beginner',
    description: 'Find carriers who need a dispatcher, run a confident first call, handle objections and follow up until they sign.',
    lessons: [
      {
        title: 'Finding carriers who need dispatch',
        minutes: 10,
        content: `# Finding the right carriers

Your best prospects are small carriers that are busy driving and have no one finding loads for them.

## Good-fit signals

- **1–5 power units.** Large fleets usually have in-house dispatch.
- **Active authority** with a phone number on file.
- **Recently activated authority.** New carriers often need help building broker relationships — but remember many brokers want aged authority.
- **Equipment you know how to book.** Start with one or two equipment types and learn their markets well.

## Building your list

1. Use **Find carriers** to search public FMCSA census data by state, fleet size and operating status.
2. Save the carriers that fit. Duplicates are detected by USDOT/MC so you never call the same company twice by accident.
3. Import any lists you already own with **Import CSV**.
4. Add the best prospects to **Prospecting**, or enrol them in a **Sequence** so your daily call list builds itself.

## Respect the people you call

- Call during the carrier's local business hours — the prospecting queue shows each carrier's local time.
- Honour do-not-call and do-not-email requests immediately. Mark the carrier in the CRM so nobody on your team contacts them again.
- Follow the telemarketing and email laws that apply to you and your prospects.

## Quality over volume

Fifty well-researched calls with notes beat two hundred rushed dials. Every call outcome you log teaches you which segments respond, and the dashboard shows your conversion by stage.`,
      },
      {
        title: 'Structure of a first call',
        minutes: 12,
        content: `# The first call

Owner-operators get many sales calls. Be brief, specific and useful.

## A simple structure

1. **Permission opener (10 seconds).** "Hi, is this Mike? This is Sara with Northline Dispatch — did I catch you driving? I'll be quick."
2. **Reason for the call.** "I work with small flatbed carriers out of Texas and noticed your authority is active. Are you currently booking your own loads?"
3. **Qualify.** Ask, then listen:
   - What equipment do you run and where do you like to run?
   - How are you finding loads right now?
   - What is the hardest part — finding loads, negotiating, or paperwork?
   - What did you average per mile last month?
4. **Offer one relevant benefit.** Tie it to what they said: "If you're spending two hours a day on load boards, I take that off your plate and negotiate every load."
5. **Clear next step.** "Can I send you my dispatch agreement and set a 10-minute call tomorrow at 8am your time to walk through it?"

## Log every outcome

After each call, log the outcome — no answer, voicemail, interested, not interested, call back, follow-up, converted. DispatchDesk schedules the next step automatically (for example, a voicemail creates a follow-up in two days).

## Voicemails

Keep them under 20 seconds: name, company, one-line reason, callback number, and say you will also send a short email. Then send it.

## Tone

Sound like someone who understands trucking. Use the carrier's language: lanes, deadhead, rate per mile, home time. Never promise specific earnings — the market moves, and over-promising destroys trust.`,
      },
      {
        title: 'Handling common objections',
        minutes: 12,
        content: `# Objection handling

Objections are questions in disguise. Acknowledge, ask a clarifying question, then answer.

## "I already find my own loads."

"That makes sense — a lot of my carriers did too. How much time do you spend on the board each day? I focus on negotiating and paperwork so you can drive more hours." Then offer a trial week.

## "Your fee is too high."

Break it down: if your fee is a percentage, show what that means on a typical load, and what one better-negotiated load or one avoided empty leg is worth. Never invent numbers — use the carrier's own figures from the conversation.

## "I had a bad dispatcher before."

Ask what went wrong. Common complaints: forced bad loads, no communication, hidden fees. Explain how you work differently and put it in writing in your dispatch agreement — the carrier always has the right to refuse a load.

## "I'm not ready / my authority is too new."

New authority limits which brokers will work with the carrier. Explain how you handle it: focusing on brokers that onboard newer carriers, building history load by load. Schedule a follow-up date rather than dropping the lead.

## "Send me some information."

Agree, send it immediately, and book the follow-up while you are still on the phone: "I'll email it now. Can I call you Thursday at 9 to answer questions?"

## "Not interested."

Thank them, ask if you can check back in a few months, and log the outcome. If they ask not to be contacted again, mark them do-not-call.

Use the **AI dispatcher** to rehearse: ask it to role-play a skeptical owner-operator and practise your answers.`,
      },
      {
        title: 'Follow-up cadence and sequences',
        minutes: 10,
        content: `# Following up

Most carriers do not sign on the first call. A consistent follow-up rhythm is where deals are won.

## A practical cadence

| Day | Step |
|---|---|
| 1 | First call (and voicemail) |
| 2 | Short follow-up email |
| 4 | Second call |
| 7 | Final follow-up email or call |

After that, move the carrier to a long-term nurture list and check back monthly or when their situation changes.

## Build it once with Sequences

In **Sequences**, create the steps above. When you enrol carriers:

- Call and task steps appear in your daily **Prospecting** queue on the right day, at the carrier's local business hours.
- Email steps are sent automatically from your connected mailbox, respecting your daily sending limit, business hours and opt-outs.
- Logging "interested" or "not interested" on a call stops the sequence so you never send an awkward email to someone who already said yes or no.

## Keep emails human

- Short subject, one idea per email, a clear question at the end.
- Personalise with merge fields (company name, equipment, state) but read every template out loud — if it sounds robotic, rewrite it.
- Include your real contact details and an easy way to opt out.

## Measure

Watch your conversion from Prospecting to Opportunity to Customer on the dashboard. If many calls are answered but few convert, work on your pitch; if few are answered, adjust your call times and lists.`,
      },
    ],
  },
  {
    slug: 'broker-communication-rate-negotiation',
    title: 'Broker Communication & Rate Negotiation',
    category: 'operations',
    level: 'intermediate',
    description: 'Evaluate loads with rate per mile and deadhead, negotiate professionally with brokers and protect your carrier.',
    lessons: [
      {
        title: 'Rate per mile, deadhead and true profitability',
        minutes: 12,
        content: `# Evaluating a load

A rate only means something relative to the miles and costs involved.

## The core formula

**Rate per mile (RPM) = total load rate ÷ loaded miles**

A $2,400 load over 800 loaded miles pays **$3.00 per loaded mile**.

## Add the deadhead

Deadhead is the empty distance from where the truck is now to the pickup. Include it:

**All-in RPM = total rate ÷ (loaded miles + deadhead miles)**

The same $2,400 load with 120 deadhead miles pays $2,400 ÷ 920 = **about $2.61 per total mile**.

## Estimate costs

- **Fuel:** total miles ÷ truck MPG × fuel price per gallon.
- **Other costs:** tolls, lumper fees the carrier pays, permits.
- **Your dispatch fee** if it comes out of the gross.

**Estimated profit = rate + detention pay − fuel − other costs − dispatch fee.**

The **Rate calculator** in DispatchDesk does this math for you, including detention. Use the carrier's real MPG and current local fuel price — do not guess.

## Know the carrier's minimum

Ask each customer for their minimum acceptable rate per mile and maximum deadhead, then record it on their customer profile. Those numbers make it easy to discard bad loads quickly.

## Look beyond one load

A slightly lower rate into a strong outbound market can beat a high rate into an area with little freight. Plan the next load before you book this one.`,
      },
      {
        title: 'Calling brokers and negotiating',
        minutes: 12,
        content: `# Negotiating with brokers

Brokers are business partners, not opponents. Be prepared, polite and specific.

## Before you call

- Know the truck's exact location, empty time, equipment and weight capacity.
- Run the numbers: your target rate and your walk-away rate.
- Check the broker's credit and days-to-pay if your load board provides it.

## On the call

1. Identify yourself as dispatch for the carrier: company name and MC.
2. Confirm load details: pickup/delivery windows, weight, commodity, special requirements, whether it is a team or solo load.
3. Ask for the rate if not posted: "What are you paying on this one?"
4. Counter with a reason: "We're 40 miles out and can pick up first thing — we'd need $2,650 to make it work."
5. Leave room: brokers often meet in the middle. Know your walk-away number and be willing to say no.

## Market awareness without guessing

Never invent "market rates." Base your position on facts you can point to: the carrier's costs, your own lane history from past bookings, and rate tools you legitimately subscribe to. If you are unsure, say so and ask the broker what the lane has been paying.

## After you agree

- Get a written **rate confirmation** before the truck rolls.
- Check every line: rate, accessorials, detention terms, pickup/delivery addresses, reference numbers, payment terms.
- Never let the carrier move freight on a verbal promise.

## Protect against fraud

Verify the broker's authority and contact details through official sources, be wary of urgent requests to change pickup locations or payment details, and watch for double brokering (a "broker" re-posting a load it does not legitimately control).`,
      },
      {
        title: 'Detention, layovers and accessorials',
        minutes: 9,
        content: `# Accessorial charges

Accessorials are payments beyond the line-haul rate. Getting them paid depends on documenting them correctly.

## Common accessorials

- **Detention:** paid when the truck is held at a shipper or receiver beyond the free time stated in the rate confirmation (two hours is common, but always read the terms).
- **Layover:** paid when the truck must wait overnight or longer because the load is not ready or delivery is rescheduled.
- **TONU (truck ordered, not used):** compensation when a load is cancelled after the truck was dispatched.
- **Lumper fees:** payments to third-party unloaders, usually reimbursed with a receipt.
- **Extra stops, driver assist, tarping:** often negotiated per load.

## Making detention stick

1. Confirm detention terms on the rate confirmation **before** pickup.
2. Have the driver record arrival and departure times, and get them on the BOL or POD when possible.
3. Notify the broker as soon as free time is about to expire — not after the fact.
4. Submit the claim with documentation promptly after delivery.

## Track it in DispatchDesk

Enter detention hours and the hourly rate on the load. The rate calculator and load totals include detention in revenue so your reports show the real value of each load.`,
      },
      {
        title: 'Building long-term broker relationships',
        minutes: 9,
        content: `# Broker relationships

The best loads are often never posted publicly — brokers give them to carriers they trust.

## Become the dispatcher brokers want to call

- **Communicate early.** Send pickup and delivery confirmations, and warn about delays before they happen.
- **Be accurate.** Only book loads the truck can really make.
- **Paperwork on time.** Send signed BOLs and PODs promptly.
- **Be consistent.** Run the same lanes regularly and tell brokers when your trucks are available there.

## Keep a broker book

Use **Brokers** in DispatchDesk to store each broker's contacts, payment terms, credit notes and the history of loads you have run with them. Before calling, review past rates on that lane and how quickly they paid.

## Send capacity, not spam

When a truck will be empty in a market, a short personalised email to brokers you already work with ("Flatbed available Dallas Thursday AM, heading to Atlanta area") is welcome. Mass unsolicited email to people you do not know is not — respect opt-outs and sending limits.

## Review the numbers

Every month, look at which brokers paid fastest, which lanes had the best rate per mile, and which relationships produce repeat freight. Focus your time there.`,
      },
    ],
  },
  {
    slug: 'carrier-onboarding-paperwork',
    title: 'Carrier Onboarding & Paperwork',
    category: 'compliance',
    level: 'beginner',
    description: 'Dispatch agreements, carrier packets, W-9, certificates of insurance, rate confirmations, BOL and POD.',
    lessons: [
      {
        title: 'The dispatch service agreement',
        minutes: 10,
        content: `# The dispatch agreement

Before you book a single load for a new customer, put your relationship in writing.

## What a dispatch agreement usually covers

- **Services:** finding loads, negotiating rates, handling broker setup and paperwork.
- **Fee:** percentage of gross per load or a flat fee, when it is due and how it is paid.
- **Authority to act:** whether you may sign rate confirmations and carrier packets on the carrier's behalf (often a limited power of attorney). Keep the scope narrow and explicit.
- **Carrier's rights:** the carrier can refuse any load; you will not force dispatch.
- **Responsibilities:** the carrier keeps authority, insurance and equipment compliant; you keep their documents confidential.
- **Term and termination:** notice period and what happens to loads in progress.

## Practical tips

- Use an agreement reviewed by a lawyer for your state. Templates from the internet are a starting point, not legal advice.
- Get it signed electronically and store it on the customer's profile under **Documents → Agreement**.
- Review it on a short call so nothing surprises the carrier later.

## Collect onboarding information at the same time

Equipment details, preferred lanes, home time, minimum rate per mile, maximum deadhead, factoring company (if any) and the best way to reach the driver. Recording this on the customer profile from day one makes every future load faster.`,
      },
      {
        title: 'The carrier packet: W-9, COI and authority',
        minutes: 11,
        content: `# The carrier packet

Every broker must vet a carrier before tendering a load. The set of documents they request is the **carrier packet** (setup packet).

## Documents you will be asked for

- **Operating authority letter:** proof the carrier's authority is active (from FMCSA).
- **W-9:** the carrier's taxpayer identification form so the broker can pay and report payments.
- **Certificate of insurance (COI):** issued by the carrier's insurance agent, listing auto liability and cargo coverage, policy numbers and dates. Brokers usually ask to be named as **certificate holder**; request this from the agent, never edit a COI yourself.
- **Notice of assignment (NOA):** if the carrier uses a factoring company, telling the broker where to send payment.
- **Signed broker-carrier agreement:** the broker's own contract.
- **Banking or payment details:** sent through secure channels only.

## Keep documents current

COIs and authority status change. Store every document on the customer profile with its type and expiry date where it applies. DispatchDesk keeps uploaded files private to your account and team permissions.

## Speed matters

Having a complete, up-to-date packet ready lets you accept a load in minutes instead of losing it while you chase paperwork. Build a folder for each customer and update it whenever the insurance renews.

## Security reminder

Carrier packets contain sensitive tax and banking information. Never post them publicly, send only to verified broker contacts, and remove access when a customer relationship ends.`,
      },
      {
        title: 'Rate confirmation, BOL and POD',
        minutes: 10,
        content: `# Load paperwork

Three documents follow every load from booking to payment.

## Rate confirmation (rate con)

Issued by the broker after you agree on a load. It is the contract for that shipment. Check it line by line:

- Carrier name and MC match your customer.
- Rate and every agreed accessorial (detention, extra stops, TONU).
- Pickup and delivery addresses, dates, appointment times and reference numbers.
- Equipment, weight and any special requirements.
- Payment terms and where to send invoices.

If anything is wrong, ask for a corrected rate con **before** the truck is dispatched. Upload the signed copy to the load in DispatchDesk.

## Bill of lading (BOL)

Created by the shipper at pickup. It describes the freight, pieces and weight, and is signed by the driver. The driver should note any discrepancies (damaged pallets, shortages, seal numbers) on the BOL before leaving.

## Proof of delivery (POD)

The BOL or delivery receipt signed by the receiver when the freight is delivered. Exceptions such as damage or shortages must be written on it.

## Close the loop

1. Driver sends clear photos or scans of the signed BOL/POD right after delivery.
2. You upload them to the load and mark it **Delivered**.
3. The carrier (or you, if contracted to) invoices the broker or submits to factoring.
4. Mark the load **Invoiced** and then **Paid** when funds arrive — your dashboard revenue stays accurate.`,
      },
      {
        title: 'Pickup to payment: running a load',
        minutes: 9,
        content: `# Running a load end to end

1. **Learn the basics** and know your carrier's equipment and limits.
2. **Find the load** that fits location, timing and rate targets.
3. **Negotiate** with the broker using real numbers.
4. **Complete the carrier packet** if this is a new broker.
5. **Review the rate confirmation** and send it to the carrier for approval.
6. **Dispatch the driver** with pickup details, appointment, reference numbers and contact information.
7. **Track pickup**: confirm arrival, loading, seal numbers and BOL.
8. **Track delivery**: update the broker, manage delays and detention.
9. **Close the load**: collect the POD, invoice or factor, record payment.

## Communication checklist

- Confirm the driver is rolling to pickup.
- Update the broker at pickup, mid-route if requested, and at delivery.
- Report any issue immediately — breakdown, delay, damage, refusal.

## Record everything

Each status change on the load in DispatchDesk becomes part of the carrier's history and your reporting. Over time you will see which lanes and brokers make your customers the most money — and your dispatch business grows from that track record.`,
      },
    ],
  },
  {
    slug: 'running-your-dispatch-business',
    title: 'Running Your Dispatch Business',
    category: 'business',
    level: 'intermediate',
    description: 'Price your service, invoice and get paid, understand factoring, and stay on the right side of compliance.',
    lessons: [
      {
        title: 'Pricing your dispatch service',
        minutes: 9,
        content: `# Pricing your service

## Common pricing models

- **Percentage of gross:** the most common model. Your fee is a percentage of each load's line-haul rate. Commonly quoted ranges in the industry are roughly in the mid-single digits to around ten percent, depending on equipment, services included and market — research your own market rather than copying a number.
- **Flat fee per load or per week:** predictable for the carrier; you carry the risk of slow weeks.
- **Hybrid:** a lower percentage plus a fixed fee for paperwork-heavy services.

## What affects your price

- Equipment complexity (flatbed securement, reefer temperature management, oversize permits).
- Extra services: invoicing, factoring coordination, compliance reminders, IFTA paperwork.
- How many trucks you manage and how much hands-on support each needs.

## Put it in writing

State the fee, what it is calculated on (line-haul only or including accessorials), when it is due and how disputes are handled — all in the dispatch agreement.

## Track your revenue

Set each customer's dispatch fee percentage on their profile. Loads record the line-haul and accessorials so your estimated revenue and profit reports reflect what you actually earn.`,
      },
      {
        title: 'Invoicing, payment terms and factoring basics',
        minutes: 10,
        content: `# Getting paid

Cash flow is the biggest challenge for small carriers — and therefore for their dispatchers.

## Broker payment terms

Brokers commonly pay on terms such as 30 days after receiving a complete invoice with POD. Many also offer **quick pay** for a fee. Record each broker's terms and real days-to-pay in DispatchDesk.

## A clean invoice includes

- Carrier legal name, MC/USDOT and remit-to details.
- Broker load number and rate confirmation reference.
- Line-haul and each accessorial with supporting documents.
- Signed BOL/POD attached.

## Factoring

A factoring company buys the carrier's invoices and pays most of the value upfront, collecting from the broker later. Terms vary widely: advance rates, fees, recourse vs. non-recourse, minimum volumes and contract length. As a dispatcher:

- Know which factoring company each customer uses and keep the notice of assignment in their packet.
- Submit paperwork quickly — late paperwork means late money.
- Never choose a factoring contract for the carrier; help them compare, and let them decide.

## Your own invoices

Invoice your dispatch fee on a regular schedule (weekly is common) with a list of the loads it covers. Keeping your records in one system makes this a five-minute task.`,
      },
      {
        title: 'Compliance cautions for dispatchers',
        minutes: 10,
        content: `# Staying compliant

This lesson is general education, not legal advice. Regulations change — **verify current rules with FMCSA and consult a transportation attorney** for your situation.

## Dispatcher vs. broker

A dispatcher who acts solely as the carrier's agent is in a different position from a broker who arranges transportation on behalf of shippers. FMCSA has published guidance on when dispatch services can require broker registration. Warning signs you may be acting as a broker include: taking payment from shippers, holding yourself out to shippers as able to provide transportation, or controlling the freight payment. Read the guidance and get advice before expanding your services.

## Do not pressure unsafe operation

Never push a driver to violate hours-of-service limits, overload a truck, or skip required inspections. Safety violations hurt the carrier's record and can create liability for everyone involved.

## Protect data

You handle tax IDs, insurance details, banking information and personal phone numbers. Keep them in secure systems, share only with verified parties, and delete what you no longer need.

## Outreach rules

Cold calling and email marketing are regulated. Honour do-not-call and opt-out requests immediately, identify yourself honestly, and include working unsubscribe options in emails. DispatchDesk's suppression list and do-not-contact flags help, but compliance remains your responsibility.

## Keep records

Keep agreements, rate confirmations, invoices and communication history organised. Good records resolve disputes quickly and show professionalism to carriers and brokers alike.`,
      },
      {
        title: 'Growing from one carrier to a team',
        minutes: 8,
        content: `# Growing your dispatch business

## Start with one great customer

Your first signed carrier is your proof. Book them well, communicate constantly, and ask for a referral once they are happy.

## Systemise before you scale

- Standard call scripts and email templates.
- A sequence for every prospect segment.
- A carrier packet checklist and a load checklist.
- Weekly review of your dashboard: dials, conversations, opportunities, trials and customers.

## Adding dispatchers

When you hire, create a **Team** in DispatchDesk. Each dispatcher keeps their own pipeline while the team board and leaderboard show everyone's activity. Give managers visibility into team data and set permissions so people see only what they need.

## Train continuously

Use the training center for onboarding new team members, track their lesson progress, and use trainer messaging for questions. Record what works in your market and turn it into your own course material.

## Measure what matters

- **Activity:** calls, emails, follow-ups completed.
- **Conversion:** prospects to opportunities to customers.
- **Customer outcomes:** loads booked, revenue, rate per mile trends.

Grow the numbers you control — activity and service quality — and revenue follows.`,
      },
    ],
  },
];

export async function seedTraining(log = () => {}) {
  let created = 0;
  for (const [i, c] of COURSES.entries()) {
    const exists = await prisma.trainingCourse.findUnique({ where: { slug: c.slug }, select: { id: true } });
    if (exists) continue;
    await prisma.trainingCourse.create({
      data: {
        slug: c.slug, title: c.title, description: c.description, category: c.category, level: c.level,
        published: true, sortOrder: i,
        lessons: { create: c.lessons.map((l, j) => ({ title: l.title, content: l.content, durationMinutes: l.minutes, sortOrder: j })) },
      },
    });
    created++;
  }
  if (created) log(`seeded ${created} training course(s)`);
}
