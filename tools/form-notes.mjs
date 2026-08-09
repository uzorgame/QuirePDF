/* What is actually worth knowing about a particular form.
 *
 * The category guide answers "what is a tax form" — useful the first time and
 * useless afterwards, because it says the same thing on all forty tax pages.
 * What people actually arrive wanting to know is narrower and more practical:
 * am I even the person who files this, when is it due, what will I be asked for
 * before I start, and what do people get wrong.
 *
 * So these are per form, and only for the forms something specific can honestly
 * be said about. A page with no entry here falls back to the category guide
 * rather than being padded out with invented detail — a confidently wrong
 * sentence about a tax deadline is worse than no sentence at all.
 *
 *   about    what it does, in one or two sentences
 *   who      who files it
 *   skip     when you do NOT need it — the question most often asked and least
 *            often answered anywhere
 *   due      the deadline, where there is a fixed one
 *   ready    what to have to hand before you start
 *   watch    what goes wrong
 *
 * Nothing here is advice, and none of it replaces the issuing agency's own
 * instructions — every form page links to those.
 */

export const NOTES = {

  /* ── Internal Revenue Service ─────────────────────────────────────── */

  'w-9': {
    about: 'A W-9 hands your taxpayer identification number to somebody who is going to pay you, so they can report that payment to the IRS and issue you a 1099 at the end of the year. It is never sent to the IRS itself — it goes to the person who asked for it, and they keep it on file.',
    who: 'Independent contractors, freelancers, consultants and other businesses being paid by a US company. Also banks and brokerages asking an account holder to certify their TIN.',
    skip: 'You do not file a W-9 if you are an employee — that is a W-4. You also do not use one if you are not a US person: a non-resident individual or foreign entity uses a W-8BEN or W-8BEN-E instead, and signing a W-9 when you are not a US person is a false certification.',
    ready: ['Your legal name exactly as it appears on your tax return', 'Your SSN, or your EIN if you are paid as a business', 'Your tax classification — sole proprietor, LLC, corporation, partnership', 'Your current mailing address'],
    watch: [
      'Line 1 must be the name on your tax return. A single-member LLC puts the owner’s name on line 1 and the LLC name on line 2, not the other way round.',
      'An LLC taxed as a disregarded entity ticks the box for its owner’s classification, not the LLC box.',
      'Do not email a completed W-9 unencrypted. It carries your full SSN and is a routine target for interception.',
    ],
  },

  'w-4': {
    about: 'A W-4 tells your employer how much federal income tax to withhold from each paycheque. It is not filed with the IRS — the employer keeps it and applies it to payroll.',
    who: 'Every new employee, and any existing employee whose circumstances change.',
    skip: 'It is not for contractors — if you are paid on a 1099 you file a W-9 instead and nothing is withheld. You also do not need a new one every year; the last one you filed keeps applying until you replace it.',
    due: 'On or before your first payday. A change takes effect on the next payroll run after your employer processes it.',
    ready: ['Your filing status', 'Details of any second job or a working spouse', 'The number of qualifying children and other dependants'],
    watch: [
      'The 2020 redesign removed allowances. If you are copying numbers from an old W-4 they will not mean what they used to.',
      'Two incomes in a household is the most common cause of under-withholding — Step 2 exists for exactly that, and skipping it is what produces a surprise bill in April.',
    ],
  },

  'w-2': {
    about: 'A W-2 reports what an employer paid one employee over the year and what was withheld from it. The employer files it; the employee receives copies to use on their return.',
    who: 'Employers, for every employee they paid wages to. Employees receive it rather than fill it in.',
    skip: 'You do not issue a W-2 to a contractor — that is a 1099-NEC. And if you are an employee, you do not fill this in at all; you wait for it.',
    due: '31 January, both to the employee and to the Social Security Administration.',
    watch: [
      'The copy that goes to the SSA has to be the scannable one. A downloaded black-and-white Copy A is for reference; filing it on paper can attract a penalty.',
      'Filing electronically avoids the scannable-copy problem entirely, and is required above the threshold set for the year.',
    ],
  },

  'w-7': {
    about: 'A W-7 applies for an Individual Taxpayer Identification Number — a tax number for people who have a US filing obligation but cannot get a Social Security number.',
    who: 'Non-resident aliens who must file a US return, their spouses and dependants, and resident aliens filing on days-present grounds.',
    skip: 'If you are eligible for a Social Security number you cannot have an ITIN, and applying for one anyway will be rejected. Apply for the SSN instead.',
    ready: ['A completed federal tax return to attach, in most cases', 'Original or certified identity documents — a passport is the only one that stands alone', 'Your foreign address'],
    watch: [
      'ITINs expire. One not used on a return for three consecutive years lapses, and a lapsed number delays any refund.',
      'The IRS wants original documents or copies certified by the issuing agency. A notarised photocopy is not accepted.',
    ],
  },

  'w-8ben': {
    about: 'A W-8BEN certifies to a US payer that you are not a US person, and claims any reduced withholding rate a tax treaty between your country and the United States allows.',
    who: 'Non-resident individuals receiving US-sourced income — royalties, dividends, interest, or payment for services.',
    skip: 'US citizens and residents use a W-9. Foreign entities rather than individuals use W-8BEN-E, which is a different and much longer form.',
    ready: ['Your country of residence for tax purposes', 'Your foreign tax identifying number', 'The treaty article you are claiming under, if any'],
    watch: [
      'A W-8BEN is valid until the end of the third year after signing, then it must be renewed. Payers usually withhold at 30% the moment it lapses.',
      'Leaving Part II blank means no treaty benefit is claimed, even if you are entitled to one.',
    ],
  },

  '1040': {
    about: 'The annual federal income tax return for individuals. Everything else — schedules, credits, additional forms — attaches to it.',
    who: 'US citizens and residents whose income passes the filing threshold for their status and age, and anyone claiming a refund of tax already withheld.',
    skip: 'If your income is under the threshold and nothing was withheld, there may be nothing to file — but filing anyway is how refundable credits are claimed, so it is often worth doing regardless.',
    due: '15 April for the previous calendar year, unless that falls on a weekend or holiday. Form 4868 buys six more months to file, but not to pay.',
    watch: [
      'An extension extends the filing date, not the payment date. Interest runs on unpaid tax from April regardless.',
      'Taxpayers over 65 may prefer 1040-SR, which is the same return set in larger type with a standard-deduction chart.',
    ],
  },

  '1040-x': {
    about: 'Amends a return you have already filed — to correct income, change a filing status, or claim something you missed.',
    who: 'Anyone who has already filed and needs to change it.',
    skip: 'Do not amend for simple arithmetic. The IRS recalculates those itself and writes to you about the difference. Amend when the underlying facts change.',
    due: 'Generally within three years of filing the original return, or two years from paying the tax, whichever is later.',
    watch: [
      'Wait until the original return has been processed. Amending while it is in flight tends to produce two conflicting records and a much longer wait.',
      'Amended returns are processed by hand and routinely take months.',
    ],
  },

  '1099-nec': {
    about: 'Reports what a business paid a non-employee — a contractor, freelancer or professional — over the year. Since 2020 it has carried non-employee compensation instead of 1099-MISC box 7.',
    who: 'Businesses that paid $600 or more to a non-employee. The contractor receives a copy rather than filing one.',
    skip: 'Payments to a corporation are generally not reported on a 1099-NEC, with attorneys the notable exception. Payments made through a card or a third-party network are reported by the processor on a 1099-K, not by you.',
    due: '31 January, to the recipient and to the IRS.',
    ready: ['A W-9 from each contractor', 'Your total payments to each of them for the year', 'Your own EIN'],
    watch: [
      'Collect the W-9 before you pay, not in January. Chasing a TIN after the fact is where most of the January panic comes from.',
      'Paper filers must also send Form 1096 as a cover sheet. E-filers do not.',
    ],
  },

  '1099-misc': {
    about: 'Reports payments that are not wages and not non-employee compensation — rent, prizes, royalties, medical payments, and other income.',
    who: 'Businesses making those payments, generally at $600 or more, or $10 for royalties.',
    skip: 'Contractor pay went to 1099-NEC in 2020 and no longer belongs here. Personal payments — paying a neighbour to mow your lawn — are not reportable at all.',
    due: '31 January to the recipient; 28 February on paper or 31 March electronically to the IRS.',
  },

  '1096': {
    about: 'A cover sheet that summarises the paper information returns you are sending the IRS — how many, of what type, and their total.',
    who: 'Anyone filing 1099s, 1098s, 3921s, 5498s or W-2Gs on paper.',
    skip: 'Electronic filers never need it. Given the threshold for mandatory e-filing is now ten returns of any type combined, most filers do not touch a 1096 at all.',
    watch: [
      'The copy the IRS scans must be the red-ink original ordered from the IRS. A downloaded copy is for reference and preparation, and filing it can attract a penalty.',
      'One 1096 per type of form. Five 1099-NECs and two 1099-INTs need two of them.',
    ],
  },

  '941': {
    about: 'The quarterly return on which an employer reports wages paid, tips reported, and the federal income tax, Social Security and Medicare withheld.',
    who: 'Most employers with payroll.',
    skip: 'Very small employers approved to file annually use Form 944 instead, and agricultural employers use Form 943. You cannot switch to 944 on your own — the IRS has to tell you to.',
    due: 'The last day of the month after each quarter ends: 30 April, 31 July, 31 October and 31 January.',
    watch: ['Filing the return is separate from depositing the tax. Deposits run on their own schedule and being late on those is penalised independently.'],
  },

  '940': {
    about: 'The annual federal unemployment (FUTA) return. FUTA is paid by the employer alone — nothing comes out of anyone’s wages.',
    who: 'Employers who paid $1,500 or more in wages in a quarter, or had an employee for any part of a day in 20 or more weeks.',
    due: '31 January for the previous year, extended to 10 February if all deposits were made on time.',
    watch: ['The credit for state unemployment tax is what brings the effective rate down. In a credit-reduction state that credit is cut, and Schedule A must be attached.'],
  },

  '4506-t': {
    about: 'Requests a transcript of a tax return — a summary of what the IRS holds — rather than a copy of the return itself.',
    who: 'Usually mortgage lenders and financial-aid offices, with the taxpayer’s authorisation.',
    skip: 'If you only want your own transcript, the IRS online account gives it immediately and free. This form is for having it sent to a third party.',
    watch: ['A transcript is not a copy of the return. If you need the actual filed document with attachments, that is Form 4506, and it carries a fee.'],
  },

  '8822': {
    about: 'Tells the IRS you have moved, so notices and refund cheques follow you.',
    who: 'Anyone who has changed address since their last return.',
    skip: 'If you are filing a return anyway, the address on it updates your record — no separate form needed. Use this between filings. A business changing its address uses 8822-B.',
    watch: ['This does not tell the Postal Service anything, and it does not tell the Social Security Administration. Those are separate notifications.'],
  },

  '8962': {
    about: 'Reconciles the advance premium tax credit paid towards your marketplace health cover against what your actual income entitled you to.',
    who: 'Anyone who had cover through a Health Insurance Marketplace and received an advance credit.',
    ready: ['Form 1095-A from the marketplace', 'Your household income and family size for the year'],
    watch: [
      'The figures come from the 1095-A. Filing before it arrives is the single most common cause of a rejected or amended return.',
      'Skipping this form when you had advance credits will hold up your refund and can block next year’s advance payments.',
    ],
  },

  'ss-4': {
    about: 'Applies for an Employer Identification Number — the tax number for a business.',
    who: 'New businesses, employers, corporations, partnerships, and estates and trusts that need their own number.',
    skip: 'A sole proprietor with no employees can generally use their own SSN. An EIN is still worth having if you would rather not hand your SSN to every client on a W-9.',
    watch: ['Applying online through the IRS gives the number immediately. This form is the route for applicants without a US taxpayer number, by fax or post, and takes weeks.'],
  },

  /* ── Immigration ──────────────────────────────────────────────────── */

  'i-9': {
    about: 'Records that an employer has checked a new hire’s identity and their right to work in the United States. It is never sent anywhere — the employer keeps it and produces it if inspected.',
    who: 'Every employer, for every employee hired in the US, citizens included.',
    skip: 'It is not for independent contractors, and not for employees hired before November 1986.',
    due: 'Section 1 by the employee on or before their first day. Section 2 by the employer within three business days of that day.',
    watch: [
      'You may not tell an employee which documents to produce. Naming a specific document is document abuse, and it is what most I-9 penalties are actually for.',
      'Retention runs to three years after the hire date or one year after employment ends, whichever is later.',
      'Only the edition current on the date of hire may be used — the form is revised and old editions are rejected.',
    ],
  },

  'i-90': {
    about: 'Applies to replace or renew a Permanent Resident Card.',
    who: 'Green-card holders whose card is expiring, lost, stolen, damaged, or carries the wrong details.',
    skip: 'Conditional residents on a two-year card do not renew with this — they file I-751 to remove the conditions. Filing I-90 by mistake wastes the fee and the months.',
    watch: ['Your status does not expire when the card does. The card is evidence of status, not the status itself.'],
  },

  'i-130': {
    about: 'A petition establishing that a family relationship to a US citizen or permanent resident exists. It is the first step, not the application for a green card.',
    who: 'US citizens and permanent residents petitioning for a relative.',
    watch: [
      'Approval of an I-130 does not grant status or a visa. Whether the relative can then adjust status or must go through consular processing depends on category and priority date.',
      'Waiting times differ enormously by relationship and country of birth. Check the Visa Bulletin before making plans.',
    ],
  },

  'i-765': {
    about: 'Applies for an Employment Authorization Document — the card that lets certain non-citizens work while their case is pending.',
    who: 'Applicants in a category eligible for work authorisation. The category code you enter decides everything about how it is processed.',
    watch: ['The eligibility category on the form must be exactly right. A wrong code is the most common reason these are rejected outright rather than merely delayed.'],
  },

  'n-400': {
    about: 'The application for naturalisation as a US citizen.',
    who: 'Permanent residents who meet the residence, physical-presence and good-moral-character requirements.',
    ready: ['Every trip outside the US since becoming a resident, with dates', 'Addresses and employers for the last five years', 'Details of any arrest or citation, however minor and however long ago'],
    watch: [
      'You may generally file 90 days before completing the residence requirement, but not a day earlier.',
      'Disclose every arrest, including ones that were dismissed or expunged. Omissions are found and they are treated far more seriously than the underlying incident.',
    ],
  },

  'g-1145': {
    about: 'Asks USCIS to text or email you when they accept your filing, instead of only posting a receipt notice.',
    who: 'Anyone filing a paper application with USCIS.',
    skip: 'Filing online already gives you an account with the same notifications, so it adds nothing there.',
    watch: ['Clip it to the very front of the package. Buried inside, it is missed.'],
  },

  /* ── Social Security and Medicare ─────────────────────────────────── */

  'ss-5': {
    about: 'Applies for a Social Security card — a first card, a replacement, or a change of name.',
    who: 'US citizens and lawfully present non-citizens who need a number or a corrected card.',
    skip: 'A card you have simply mislaid is not worth replacing if you know the number and have used it recently — the card itself proves nothing beyond the number, and replacements are capped at three a year and ten in a lifetime.',
    ready: ['Original documents proving identity, age and citizenship or immigration status', 'For a name change, the document that changed it'],
    watch: ['Originals or agency-certified copies only. Photocopies and notarised copies are returned unprocessed.'],
  },

  'ssa-561': {
    about: 'Asks Social Security to look again at a decision you disagree with — the first step of the appeal process.',
    who: 'Anyone who has received a determination they think is wrong.',
    due: 'Generally within 60 days of receiving the notice. Late requests need good cause.',
    watch: ['Say what you disagree with and why, specifically. "I disagree" without a reason gives the reviewer nothing new to work with, and the reconsideration reaches the same answer.'],
  },

  'cms-40b': {
    about: 'Applies for Medicare Part B when you did not take it at 65.',
    who: 'People enrolling during a special enrolment period, usually after employer cover ends.',
    skip: 'If you are already receiving Social Security when you turn 65, Parts A and B start automatically and there is nothing to file.',
    watch: ['A special enrolment period runs eight months from the end of the employment or the group cover, whichever comes first. Miss it and you wait for the general enrolment period and pay a permanent late penalty.'],
  },

  'cms-l564': {
    about: 'Your employer’s written confirmation that you had group health cover through work — the evidence that supports a special enrolment period for Part B.',
    who: 'Filed with CMS-40B by anyone enrolling late because they were covered by an employer.',
    watch: ['Section B is completed by the employer, not by you. Allow time for that — it is the part that holds these up.'],
  },

  /* ── Passports ────────────────────────────────────────────────────── */

  'ds-11': {
    about: 'The application for a first US passport, and for anyone who cannot renew by post.',
    who: 'First-time applicants, all children under 16, and anyone whose previous passport was lost, stolen, damaged, or issued more than 15 years ago.',
    skip: 'If your most recent passport is undamaged, was issued in the last 15 years, when you were 16 or older, and is in your current name, you can renew by post with DS-82 and save the trip.',
    due: 'There is no deadline, but routine processing runs to several weeks and longer in spring. Check the current times before booking travel.',
    ready: ['Proof of citizenship — certified birth certificate or a previous passport', 'A photo ID and a photocopy of it', 'One 2×2 inch colour photograph taken in the last six months'],
    watch: [
      'Do not sign it until the acceptance agent tells you to. It is signed in front of them.',
      'Both parents or guardians must appear for a child under 16, or the absent one must consent on DS-3053.',
      'Your proof of citizenship is sent in and held during processing. Plan around not having it.',
    ],
  },

  'ds-82': {
    about: 'Renews a US passport by post, without an appointment.',
    who: 'Adults whose most recent passport meets every renewal condition.',
    skip: 'You cannot use it if the passport was issued before you were 16, was issued more than 15 years ago, is damaged or missing, or is in a name you can no longer document. Any of those means DS-11 in person.',
    ready: ['Your most recent passport, which is posted in with the form', 'One 2×2 inch photograph', 'A certified marriage certificate or court order if the name has changed'],
    watch: ['Send it by a trackable method. The old passport travels with the application, and it is returned separately from the new one.'],
  },

  'ds-64': {
    about: 'Reports a passport lost or stolen. It invalidates the book immediately so it cannot be used by anyone else.',
    who: 'Anyone whose passport has gone missing.',
    watch: [
      'Once reported, the passport is dead. If it turns up afterwards it cannot be used and must be sent in.',
      'File it with a DS-11, because a lost passport can only be replaced in person.',
    ],
  },

  /* ── Templates ────────────────────────────────────────────────────── */

  'residential-lease-agreement': {
    about: 'Sets out who is renting what, for how long, at what rent, and on what terms.',
    who: 'A landlord and a tenant, before the tenant moves in.',
    ready: ['The full legal names of everyone who will live there', 'The exact address including any unit number', 'Rent, due date, deposit and late-fee terms', 'Which utilities each side pays'],
    watch: [
      'Deposits are the most regulated part of a tenancy: how much may be taken, where it must be held, and how quickly it must be returned are all set by state law, and a clause that contradicts it is unenforceable.',
      'Many states require specific disclosures — lead paint for pre-1978 housing is a federal one.',
      'Everyone over 18 who lives there should sign, or you cannot hold them to it.',
    ],
  },

  'vehicle-bill-of-sale': {
    about: 'Records the sale of a vehicle: who sold it, who bought it, for how much, and on what date.',
    who: 'Private buyers and sellers. Dealers use their own paperwork.',
    ready: ['The VIN, exactly as it appears on the vehicle', 'The odometer reading on the day of sale', 'Both parties’ names, addresses and ID'],
    watch: [
      'Federal law requires an odometer disclosure on most vehicles under 20 years old, and a false one is a federal offence.',
      'A bill of sale is not a title transfer. The title still has to be signed over and filed with the motor-vehicle agency.',
      'Some states require it to be notarised. Check before you meet.',
    ],
  },

  'general-power-of-attorney': {
    about: 'Authorises someone to act for you — signing, banking, dealing with property — within the limits you set.',
    who: 'Anyone who needs another person able to act on their behalf.',
    skip: 'A general power of attorney ends if you lose capacity, which is usually the moment it was wanted. If that is the point, a durable power of attorney is the one to use.',
    watch: [
      'Banks routinely refuse powers of attorney that are not on their own form or are more than a year or two old. Ask the institution before you need it to work.',
      'Most states want it notarised, and some want witnesses as well.',
      'It ends on death. It cannot be used to settle an estate — that is an executor’s job.',
    ],
  },

  'quitclaim-deed': {
    about: 'Transfers whatever interest the grantor has in a property, with no promise that the interest is worth anything.',
    who: 'Usually family: adding a spouse, transferring into a trust, clearing up a title between people who trust each other.',
    skip: 'Never use one to buy property from a stranger. It warrants nothing — if the seller turns out to own none of it, you have no claim. An arm’s-length purchase wants a warranty deed and title insurance.',
    watch: [
      'It must be recorded with the county to be effective against anyone else.',
      'A quitclaim does not touch the mortgage. The person who signed the loan still owes it after signing the property away.',
    ],
  },

  'non-disclosure-agreement': {
    about: 'Binds one or both sides to keep named information confidential.',
    who: 'Businesses sharing something commercially sensitive before or during a deal.',
    ready: ['What exactly counts as confidential', 'How long the obligation runs', 'What the receiving party is allowed to do with it'],
    watch: [
      '"All information exchanged" is so broad that courts often will not enforce it. Define the categories.',
      'Carve out what was already public, already known, or independently developed — without those exceptions the agreement is unreasonable on its face.',
    ],
  },

  'promissory-note': {
    about: 'A written promise to repay money: how much, to whom, at what interest, and on what schedule.',
    who: 'Anyone lending or borrowing privately, including between family.',
    ready: ['The principal', 'The interest rate', 'The repayment schedule and final date', 'What happens on a missed payment'],
    watch: [
      'Every state caps private interest rates. Exceeding the cap can void the interest and sometimes the whole debt.',
      'A family loan at no interest or below the IRS applicable federal rate can be treated as a gift for tax purposes.',
    ],
  },

  'credit-dispute-letter': {
    about: 'Formally asks a credit bureau to investigate and correct something on your report.',
    who: 'Anyone who has found an error on their credit file.',
    watch: [
      'The Fair Credit Reporting Act gives the bureau 30 days from receipt. Send it so you can prove when it arrived — that date is what starts the clock.',
      'Dispute with the bureau and with the company that reported the entry. Fixing it at one does not fix it at the other.',
      'Send copies of your evidence, never originals. You will not get them back.',
    ],
  },

  'esa-letter': {
    about: 'A licensed clinician’s written statement that an animal is part of a patient’s treatment.',
    who: 'Written by the clinician treating the patient — not by the patient, and not by a website.',
    skip: 'It is not a service-animal document and gives no right of public access. Restaurants, shops and offices can refuse an emotional support animal, and since 2021 US airlines have not had to carry one either.',
    watch: [
      'Housing providers may verify the clinician’s licence and the treating relationship. Letters bought online are routinely rejected, and several states now make selling them an offence.',
      'The letter should state the clinician is treating you. It should not state your diagnosis — a landlord is not entitled to it.',
    ],
  },
};

export const noteFor = (slug) => NOTES[slug];
