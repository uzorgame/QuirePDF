import type {FormSpec} from './formDocs';

/* What each form in the library actually contains.
 *
 * These are descriptions, not drawings: the builder turns them into a laid-out
 * page with real AcroForm widgets. Adding a form means adding an entry here.
 *
 * Only the fill-in templates live in this file. The official federal forms —
 * W-9, DS-11, I-9 and the rest — are deliberately absent: their pages link to
 * the issuing agency, because a tax or immigration form re-typed by a third
 * party is exactly the thing nobody should file. */

const party = (who: string) => ({
  title: who,
  fields: [
    {label: 'Full name', span: 1 as const},
    {label: 'Address', span: 1 as const},
    {label: 'City', span: 0.5 as const},
    {label: 'Postcode', span: 0.5 as const},
    {label: 'Phone', span: 0.5 as const},
    {label: 'Email', span: 0.5 as const},
  ],
});

const signatures = (a: string, b?: string): FormSpec['sections'][number] => ({
  title: 'Signatures',
  fields: [
    {label: a, kind: 'signature', span: 0.5, hint: 'Sign above'},
    {label: 'Date', kind: 'date', span: 0.5},
    ...(b ? [
      {label: b, kind: 'signature' as const, span: 0.5 as const, hint: 'Sign above'},
      {label: 'Date ', kind: 'date' as const, span: 0.5 as const},
    ] : []),
  ],
});

const NOT_ADVICE = 'This is a fill-in template, not a government form and not legal advice. '
  + 'Requirements differ by jurisdiction — check the rules where you are.';

export const FORM_SPECS: Record<string, FormSpec> = {

  'residential-lease-agreement': {
    title: 'Residential lease agreement',
    subtitle: 'Between the landlord and the tenant named below',
    sections: [
      party('Landlord'), party('Tenant'),
      {title: 'The property', fields: [
        {label: 'Address of the premises', span: 1},
        {label: 'Type', span: 0.5, hint: 'House, flat, room'},
        {label: 'Furnished', kind: 'check', span: 0.5, hint: 'Tick if furnished'},
      ]},
      {title: 'Term and rent', fields: [
        {label: 'Start date', kind: 'date', span: 0.5},
        {label: 'End date', kind: 'date', span: 0.5},
        {label: 'Monthly rent', kind: 'money', span: 0.5},
        {label: 'Due on day of month', span: 0.5},
        {label: 'Security deposit', kind: 'money', span: 0.5},
        {label: 'Late fee after', span: 0.5, hint: 'Days'},
      ]},
      {title: 'Utilities and conditions', fields: [
        {label: 'Utilities paid by the tenant', kind: 'multiline'},
        {label: 'Pets, smoking and other conditions', kind: 'multiline'},
      ]},
      signatures('Landlord signature', 'Tenant signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'month-to-month-rental-agreement': {
    title: 'Month-to-month rental agreement',
    subtitle: 'A tenancy that renews each month until either side gives notice',
    sections: [
      party('Landlord'), party('Tenant'),
      {title: 'The property and terms', fields: [
        {label: 'Address of the premises', span: 1},
        {label: 'Start date', kind: 'date', span: 0.5},
        {label: 'Monthly rent', kind: 'money', span: 0.5},
        {label: 'Notice required', span: 0.5, hint: 'Days, from either party'},
        {label: 'Security deposit', kind: 'money', span: 0.5},
        {label: 'Conditions', kind: 'multiline'},
      ]},
      signatures('Landlord signature', 'Tenant signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'eviction-notice': {
    title: 'Notice to quit',
    subtitle: 'Formal notice that a tenancy is ending',
    sections: [
      {title: 'To the tenant', fields: [
        {label: 'Tenant name', span: 1},
        {label: 'Address of the premises', span: 1},
      ]},
      {title: 'The notice', fields: [
        {label: 'Date of this notice', kind: 'date', span: 0.5},
        {label: 'Vacate by', kind: 'date', span: 0.5},
        {label: 'Reason', kind: 'multiline'},
        {label: 'Amount owed, if any', kind: 'money', span: 0.5},
        {label: 'Cure period', span: 0.5, hint: 'Days to put it right'},
      ]},
      {title: 'From the landlord', fields: [
        {label: 'Landlord name', span: 0.5},
        {label: 'Contact', span: 0.5},
      ]},
      signatures('Landlord signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'quitclaim-deed': {
    title: 'Quitclaim deed',
    subtitle: 'Transfers whatever interest the grantor has, with no warranty',
    sections: [
      {title: 'Parties', fields: [
        {label: 'Grantor', span: 0.5}, {label: 'Grantee', span: 0.5},
        {label: 'Grantor address', span: 0.5}, {label: 'Grantee address', span: 0.5},
      ]},
      {title: 'The property', fields: [
        {label: 'County and state', span: 0.5},
        {label: 'Parcel or tax number', span: 0.5},
        {label: 'Legal description', kind: 'multiline'},
        {label: 'Consideration', kind: 'money', span: 0.5},
        {label: 'Date of transfer', kind: 'date', span: 0.5},
      ]},
      {title: 'Notary block', note: 'Completed by the notary public, not by you.', fields: [
        {label: 'State and county', span: 0.5},
        {label: 'Date sworn', kind: 'date', span: 0.5},
        {label: 'Notary signature', kind: 'signature', span: 0.5},
        {label: 'Commission expires', kind: 'date', span: 0.5},
      ]},
      signatures('Grantor signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'residential-property-sale-agreement': {
    title: 'Residential property sale agreement',
    sections: [
      party('Seller'), party('Buyer'),
      {title: 'The property and price', fields: [
        {label: 'Address', span: 1},
        {label: 'Purchase price', kind: 'money', span: 0.5},
        {label: 'Deposit', kind: 'money', span: 0.5},
        {label: 'Closing date', kind: 'date', span: 0.5},
        {label: 'Possession date', kind: 'date', span: 0.5},
        {label: 'Included fixtures and contents', kind: 'multiline'},
        {label: 'Conditions', kind: 'multiline', hint: 'Finance, survey, sale of another property'},
      ]},
      signatures('Seller signature', 'Buyer signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'vehicle-bill-of-sale': {
    title: 'Vehicle bill of sale',
    subtitle: 'With odometer disclosure',
    sections: [
      {title: 'Parties', fields: [
        {label: 'Seller name', span: 0.5}, {label: 'Buyer name', span: 0.5},
        {label: 'Seller address', span: 0.5}, {label: 'Buyer address', span: 0.5},
      ]},
      {title: 'The vehicle', fields: [
        {label: 'Make', span: 0.33}, {label: 'Model', span: 0.33}, {label: 'Year', span: 0.33},
        {label: 'VIN', span: 0.5}, {label: 'Registration', span: 0.5},
        {label: 'Colour', span: 0.5}, {label: 'Odometer reading', span: 0.5},
        {label: 'Odometer is accurate', kind: 'check', span: 0.5, hint: 'To the best of my knowledge'},
        {label: 'Sold as seen, without warranty', kind: 'check', span: 0.5},
      ]},
      {title: 'Sale', fields: [
        {label: 'Price', kind: 'money', span: 0.5},
        {label: 'Date of sale', kind: 'date', span: 0.5},
        {label: 'Payment method', span: 1},
      ]},
      signatures('Seller signature', 'Buyer signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'general-bill-of-sale': {
    title: 'Bill of sale',
    subtitle: 'For personal property',
    sections: [
      {title: 'Parties', fields: [
        {label: 'Seller name', span: 0.5}, {label: 'Buyer name', span: 0.5},
        {label: 'Seller address', span: 0.5}, {label: 'Buyer address', span: 0.5},
      ]},
      {title: 'The goods', fields: [
        {label: 'Description of the item or items', kind: 'multiline'},
        {label: 'Condition', span: 0.5}, {label: 'Serial or identifying number', span: 0.5},
        {label: 'Price', kind: 'money', span: 0.5}, {label: 'Date of sale', kind: 'date', span: 0.5},
        {label: 'Sold as seen, without warranty', kind: 'check', span: 1},
      ]},
      signatures('Seller signature', 'Buyer signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'non-disclosure-agreement': {
    title: 'Mutual non-disclosure agreement',
    sections: [
      {title: 'Parties', fields: [
        {label: 'First party', span: 0.5}, {label: 'Second party', span: 0.5},
        {label: 'First party address', span: 0.5}, {label: 'Second party address', span: 0.5},
      ]},
      {title: 'Scope', fields: [
        {label: 'Effective date', kind: 'date', span: 0.5},
        {label: 'Term', span: 0.5, hint: 'Years the duty lasts'},
        {label: 'Purpose of the disclosure', kind: 'multiline'},
        {label: 'What counts as confidential', kind: 'multiline'},
        {label: 'Governing law', span: 1},
      ]},
      signatures('First party signature', 'Second party signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'promissory-note': {
    title: 'Promissory note',
    subtitle: 'A written promise to repay a loan',
    sections: [
      {title: 'Parties', fields: [
        {label: 'Borrower', span: 0.5}, {label: 'Lender', span: 0.5},
        {label: 'Borrower address', span: 0.5}, {label: 'Lender address', span: 0.5},
      ]},
      {title: 'The loan', fields: [
        {label: 'Principal amount', kind: 'money', span: 0.5},
        {label: 'Interest rate', span: 0.5, hint: 'Per year'},
        {label: 'Date of the loan', kind: 'date', span: 0.5},
        {label: 'Repayment due', kind: 'date', span: 0.5},
        {label: 'Repayment schedule', kind: 'multiline'},
        {label: 'What happens on default', kind: 'multiline'},
      ]},
      signatures('Borrower signature', 'Lender signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'independent-contractor-agreement': {
    title: 'Independent contractor agreement',
    sections: [
      party('Client'), party('Contractor'),
      {title: 'The work', fields: [
        {label: 'Description of the services', kind: 'multiline'},
        {label: 'Start date', kind: 'date', span: 0.5},
        {label: 'Completion date', kind: 'date', span: 0.5},
        {label: 'Fee', kind: 'money', span: 0.5},
        {label: 'Payment terms', span: 0.5, hint: 'Days from invoice'},
        {label: 'Who owns the work produced', kind: 'multiline'},
        {label: 'Contractor supplies their own tools and equipment', kind: 'check', span: 1},
      ]},
      signatures('Client signature', 'Contractor signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'commercial-invoice': {
    title: 'Commercial invoice',
    subtitle: 'For an international shipment',
    sections: [
      {title: 'Shipment', fields: [
        {label: 'Invoice number', span: 0.33}, {label: 'Date', kind: 'date', span: 0.33},
        {label: 'Tracking number', span: 0.33},
        {label: 'Shipper', span: 0.5}, {label: 'Consignee', span: 0.5},
        {label: 'Shipper address', span: 0.5}, {label: 'Consignee address', span: 0.5},
        {label: 'Country of origin', span: 0.5}, {label: 'Country of destination', span: 0.5},
      ]},
      {title: 'Goods', fields: [
        {label: 'Description, quantity and value of each item', kind: 'multiline'},
        {label: 'Total value', kind: 'money', span: 0.5},
        {label: 'Currency', span: 0.5},
        {label: 'Reason for export', span: 0.5, hint: 'Sale, gift, sample, repair'},
        {label: 'Incoterm', span: 0.5},
      ]},
      signatures('Shipper signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'general-power-of-attorney': {
    title: 'General power of attorney',
    subtitle: 'Authorises another person to act on your behalf',
    sections: [
      {title: 'Parties', fields: [
        {label: 'Principal', span: 0.5, hint: 'The person granting authority'},
        {label: 'Agent', span: 0.5, hint: 'The person receiving it'},
        {label: 'Principal address', span: 0.5}, {label: 'Agent address', span: 0.5},
      ]},
      {title: 'Authority granted', fields: [
        {label: 'Powers granted', kind: 'multiline'},
        {label: 'Limits and exclusions', kind: 'multiline'},
        {label: 'Effective from', kind: 'date', span: 0.5},
        {label: 'Expires on', kind: 'date', span: 0.5},
      ]},
      {title: 'Notary block', note: 'Completed by the notary public.', fields: [
        {label: 'State and county', span: 0.5},
        {label: 'Notary signature', kind: 'signature', span: 0.5},
      ]},
      signatures('Principal signature', 'Agent signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'durable-power-of-attorney': {
    title: 'Durable power of attorney for finances',
    subtitle: 'Stays in effect if the principal becomes unable to act',
    sections: [
      {title: 'Parties', fields: [
        {label: 'Principal', span: 0.5}, {label: 'Agent', span: 0.5},
        {label: 'Alternate agent', span: 0.5}, {label: 'Effective from', kind: 'date', span: 0.5},
      ]},
      {title: 'Financial powers', fields: [
        {label: 'Banking and payments', kind: 'check', span: 0.5},
        {label: 'Property and real estate', kind: 'check', span: 0.5},
        {label: 'Investments', kind: 'check', span: 0.5},
        {label: 'Tax matters', kind: 'check', span: 0.5},
        {label: 'Any limits on these powers', kind: 'multiline'},
      ]},
      {title: 'Notary block', note: 'Completed by the notary public.', fields: [
        {label: 'State and county', span: 0.5},
        {label: 'Notary signature', kind: 'signature', span: 0.5},
      ]},
      signatures('Principal signature', 'Agent signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'last-will-and-testament': {
    title: 'Last will and testament',
    sections: [
      {title: 'The testator', fields: [
        {label: 'Full name', span: 0.5}, {label: 'Date of birth', kind: 'date', span: 0.5},
        {label: 'Address', span: 1},
      ]},
      {title: 'Executor', fields: [
        {label: 'Executor name', span: 0.5}, {label: 'Alternate executor', span: 0.5},
      ]},
      {title: 'Bequests', fields: [
        {label: 'Specific gifts', kind: 'multiline'},
        {label: 'Who receives the remainder', kind: 'multiline'},
        {label: 'Guardian for any minor children', span: 1},
      ]},
      {title: 'Witnesses', note: 'Most jurisdictions require two witnesses who receive nothing under the will.', fields: [
        {label: 'First witness', kind: 'signature', span: 0.5},
        {label: 'Second witness', kind: 'signature', span: 0.5},
      ]},
      signatures('Testator signature'),
    ],
    footnote: NOT_ADVICE + ' A will is one of the documents most worth showing to a solicitor.',
  },

  'affidavit-of-identity': {
    title: 'Affidavit of identity',
    subtitle: 'A sworn statement confirming who you are',
    sections: [
      {title: 'Affiant', fields: [
        {label: 'Full legal name', span: 1},
        {label: 'Other names used', span: 1},
        {label: 'Date of birth', kind: 'date', span: 0.5},
        {label: 'Identification number', span: 0.5},
        {label: 'Address', span: 1},
      ]},
      {title: 'Statement', fields: [
        {label: 'I declare the following to be true', kind: 'multiline'},
      ]},
      {title: 'Notary block', note: 'Completed by the notary public.', fields: [
        {label: 'State and county', span: 0.5},
        {label: 'Date sworn', kind: 'date', span: 0.5},
        {label: 'Notary signature', kind: 'signature', span: 0.5},
        {label: 'Commission expires', kind: 'date', span: 0.5},
      ]},
      signatures('Affiant signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'notary-acknowledgment-individual': {
    title: 'Notary acknowledgment',
    subtitle: 'For an individual',
    sections: [
      {title: 'Venue', fields: [
        {label: 'State', span: 0.5}, {label: 'County', span: 0.5},
      ]},
      {title: 'Acknowledgment', fields: [
        {label: 'Date', kind: 'date', span: 0.5},
        {label: 'Name of the person appearing', span: 0.5},
        {label: 'Document acknowledged', span: 1},
        {label: 'Identification presented', span: 1},
      ]},
      {title: 'Notary', fields: [
        {label: 'Notary name', span: 0.5}, {label: 'Commission number', span: 0.5},
        {label: 'Commission expires', kind: 'date', span: 0.5},
        {label: 'Notary signature', kind: 'signature', span: 0.5},
      ]},
    ],
    footnote: NOT_ADVICE,
  },

  'notary-acknowledgment-cash-receipt': {
    title: 'Notary acknowledgment for a cash receipt',
    sections: [
      {title: 'Venue', fields: [
        {label: 'State', span: 0.5}, {label: 'County', span: 0.5},
      ]},
      {title: 'The payment', fields: [
        {label: 'Amount received', kind: 'money', span: 0.5},
        {label: 'Date received', kind: 'date', span: 0.5},
        {label: 'Received from', span: 0.5}, {label: 'Received by', span: 0.5},
        {label: 'For', kind: 'multiline'},
      ]},
      {title: 'Notary', fields: [
        {label: 'Notary name', span: 0.5}, {label: 'Commission expires', kind: 'date', span: 0.5},
        {label: 'Notary signature', kind: 'signature', span: 1},
      ]},
    ],
    footnote: NOT_ADVICE,
  },

  'notarial-certificate-child-travel': {
    title: 'Notarial certificate for child travel consent',
    sections: [
      {title: 'Venue', fields: [
        {label: 'State', span: 0.5}, {label: 'County', span: 0.5},
      ]},
      {title: 'Appearance', fields: [
        {label: 'Date', kind: 'date', span: 0.5},
        {label: 'Parent or guardian appearing', span: 0.5},
        {label: 'Child named in the consent', span: 0.5},
        {label: 'Identification presented', span: 0.5},
      ]},
      {title: 'Notary', fields: [
        {label: 'Notary name', span: 0.5}, {label: 'Commission expires', kind: 'date', span: 0.5},
        {label: 'Notary signature', kind: 'signature', span: 1},
      ]},
    ],
    footnote: NOT_ADVICE,
  },

  'parental-consent-minor-travel': {
    title: "Parental consent for a minor's travel",
    sections: [
      {title: 'The child', fields: [
        {label: 'Child full name', span: 0.5}, {label: 'Date of birth', kind: 'date', span: 0.5},
        {label: 'Passport number', span: 0.5}, {label: 'Nationality', span: 0.5},
      ]},
      {title: 'The travel', fields: [
        {label: 'Destination', span: 0.5}, {label: 'Purpose', span: 0.5},
        {label: 'Departure date', kind: 'date', span: 0.5}, {label: 'Return date', kind: 'date', span: 0.5},
        {label: 'Travelling with', span: 1, hint: 'Name and relationship to the child'},
        {label: 'Accompanying adult contact', span: 1},
      ]},
      {title: 'Consent', fields: [
        {label: 'Consenting parent or guardian', span: 0.5},
        {label: 'Relationship to the child', span: 0.5},
        {label: 'Contact during the trip', span: 1},
        {label: 'I consent to medical treatment in an emergency', kind: 'check', span: 1},
      ]},
      signatures('Parent or guardian signature'),
    ],
    footnote: NOT_ADVICE + ' Many border authorities expect this notarised.',
  },

  'parental-consent-both-parents': {
    title: 'Parental consent for a minor travelling without both parents',
    sections: [
      {title: 'The child', fields: [
        {label: 'Child full name', span: 0.5}, {label: 'Date of birth', kind: 'date', span: 0.5},
      ]},
      {title: 'Parents or guardians', fields: [
        {label: 'First parent name', span: 0.5}, {label: 'Second parent name', span: 0.5},
        {label: 'First parent contact', span: 0.5}, {label: 'Second parent contact', span: 0.5},
      ]},
      {title: 'The travel', fields: [
        {label: 'Destination', span: 0.5}, {label: 'Dates', span: 0.5},
        {label: 'Accompanying adult and relationship', span: 1},
      ]},
      signatures('First parent signature', 'Second parent signature'),
    ],
    footnote: NOT_ADVICE + ' Many border authorities expect this notarised.',
  },

  'hipaa-release': {
    title: 'Medical records release authorisation',
    subtitle: 'Authorises a provider to release your health information',
    sections: [
      {title: 'Patient', fields: [
        {label: 'Patient name', span: 0.5}, {label: 'Date of birth', kind: 'date', span: 0.5},
        {label: 'Address', span: 1},
        {label: 'Record or patient number', span: 0.5}, {label: 'Phone', span: 0.5},
      ]},
      {title: 'Release to', fields: [
        {label: 'Name of the person or organisation', span: 1},
        {label: 'Address', span: 1},
        {label: 'Purpose of the release', span: 1},
      ]},
      {title: 'What may be released', fields: [
        {label: 'Complete record', kind: 'check', span: 0.5},
        {label: 'Specific dates or visits only', kind: 'check', span: 0.5},
        {label: 'If specific, describe', kind: 'multiline'},
        {label: 'This authorisation expires on', kind: 'date', span: 1},
      ]},
      signatures('Patient or representative signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'medical-consent-for-minor': {
    title: 'Medical treatment consent for a minor',
    sections: [
      {title: 'The child', fields: [
        {label: 'Child name', span: 0.5}, {label: 'Date of birth', kind: 'date', span: 0.5},
        {label: 'Known allergies', span: 1},
        {label: 'Current medication', span: 1},
        {label: 'Insurance details', span: 1},
      ]},
      {title: 'Authorised carer', fields: [
        {label: 'Carer name', span: 0.5}, {label: 'Relationship', span: 0.5},
        {label: 'Carer phone', span: 1},
        {label: 'Period this consent covers', span: 1},
      ]},
      {title: 'Parent or guardian', fields: [
        {label: 'Name', span: 0.5}, {label: 'Emergency phone', span: 0.5},
        {label: 'I authorise emergency treatment if I cannot be reached', kind: 'check', span: 1},
      ]},
      signatures('Parent or guardian signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'immunization-record': {
    title: 'Immunisation record',
    sections: [
      {title: 'Patient', fields: [
        {label: 'Full name', span: 0.5}, {label: 'Date of birth', kind: 'date', span: 0.5},
        {label: 'Record number', span: 0.5}, {label: 'Blood group', span: 0.5},
      ]},
      {title: 'Vaccinations', note: 'Vaccine, date given, dose, batch number and the clinic that gave it.', fields: [
        {label: 'Record of doses', kind: 'multiline'},
        {label: 'Doses continued', kind: 'multiline'},
      ]},
      {title: 'Provider', fields: [
        {label: 'Clinic or provider', span: 0.5}, {label: 'Phone', span: 0.5},
        {label: 'Provider signature', kind: 'signature', span: 1},
      ]},
    ],
    footnote: NOT_ADVICE,
  },

  'living-will': {
    title: 'Living will and advance healthcare directive',
    sections: [
      {title: 'Declarant', fields: [
        {label: 'Full name', span: 0.5}, {label: 'Date of birth', kind: 'date', span: 0.5},
        {label: 'Address', span: 1},
      ]},
      {title: 'Healthcare agent', fields: [
        {label: 'Agent name', span: 0.5}, {label: 'Agent phone', span: 0.5},
        {label: 'Alternate agent', span: 0.5}, {label: 'Alternate phone', span: 0.5},
      ]},
      {title: 'My wishes', fields: [
        {label: 'Life-sustaining treatment', kind: 'multiline'},
        {label: 'Pain relief and comfort care', kind: 'multiline'},
        {label: 'Organ donation', kind: 'multiline'},
      ]},
      {title: 'Witnesses', fields: [
        {label: 'First witness', kind: 'signature', span: 0.5},
        {label: 'Second witness', kind: 'signature', span: 0.5},
      ]},
      signatures('Declarant signature'),
    ],
    footnote: NOT_ADVICE + ' Rules for advance directives vary widely — check yours.',
  },

  /* ── the documents people ask for that we did not already have ───────
     Chosen from what is actually searched for rather than from what is easy to
     lay out. Each is a real fill-in template with proper widgets. */

  'rental-application': {
    title: 'Rental application',
    subtitle: 'What a landlord asks before offering a tenancy',
    sections: [
      {title: 'Applicant', fields: [
        {label: 'Full name', span: 0.5}, {label: 'Date of birth', kind: 'date', span: 0.5},
        {label: 'Phone', span: 0.5}, {label: 'Email', span: 0.5},
        {label: 'Current address', span: 1},
        {label: 'Time at this address', span: 0.5}, {label: 'Reason for moving', span: 0.5},
      ]},
      {title: 'Employment and income', fields: [
        {label: 'Employer', span: 0.5}, {label: 'Position', span: 0.5},
        {label: 'Monthly gross income', kind: 'money', span: 0.5},
        {label: 'Length of employment', span: 0.5},
        {label: 'Other income and source', kind: 'multiline'},
      ]},
      {title: 'Rental history', fields: [
        {label: 'Previous landlord', span: 0.5}, {label: 'Landlord phone', span: 0.5},
        {label: 'Previous monthly rent', kind: 'money', span: 0.5},
        {label: 'Dates of tenancy', span: 0.5},
      ]},
      {title: 'Occupants and pets', fields: [
        {label: 'Other occupants', kind: 'multiline'},
        {label: 'Pets', span: 0.5}, {label: 'Smoker', kind: 'check', span: 0.5, hint: 'Tick if yes'},
      ]},
      {title: 'References', fields: [
        {label: 'Reference name', span: 0.5}, {label: 'Reference phone', span: 0.5},
      ]},
      signatures('Applicant signature'),
    ],
    footnote: NOT_ADVICE + ' Fair-housing law limits what a landlord may ask — check yours before using this.',
  },

  'rental-ledger': {
    title: 'Rent payment ledger',
    subtitle: 'What was due, what was paid, and what is still owed',
    sections: [
      {title: 'Tenancy', fields: [
        {label: 'Tenant name', span: 0.5}, {label: 'Property address', span: 0.5},
        {label: 'Monthly rent', kind: 'money', span: 0.5},
        {label: 'Rent due on day of month', span: 0.5},
      ]},
      {title: 'Payments', note: 'One row per payment. Carry the balance down to the summary below.', fields: [
        {label: 'Date', kind: 'date', span: 0.25}, {label: 'Period covered', span: 0.25},
        {label: 'Amount due', kind: 'money', span: 0.25}, {label: 'Amount paid', kind: 'money', span: 0.25},
        {label: 'Date ', kind: 'date', span: 0.25}, {label: 'Period covered ', span: 0.25},
        {label: 'Amount due ', kind: 'money', span: 0.25}, {label: 'Amount paid ', kind: 'money', span: 0.25},
        {label: 'Date  ', kind: 'date', span: 0.25}, {label: 'Period covered  ', span: 0.25},
        {label: 'Amount due  ', kind: 'money', span: 0.25}, {label: 'Amount paid  ', kind: 'money', span: 0.25},
        {label: 'Date   ', kind: 'date', span: 0.25}, {label: 'Period covered   ', span: 0.25},
        {label: 'Amount due   ', kind: 'money', span: 0.25}, {label: 'Amount paid   ', kind: 'money', span: 0.25},
        {label: 'Date    ', kind: 'date', span: 0.25}, {label: 'Period covered    ', span: 0.25},
        {label: 'Amount due    ', kind: 'money', span: 0.25}, {label: 'Amount paid    ', kind: 'money', span: 0.25},
      ]},
      {title: 'Balance', fields: [
        {label: 'Total due to date', kind: 'money', span: 0.5},
        {label: 'Total paid to date', kind: 'money', span: 0.5},
        {label: 'Outstanding balance', kind: 'money', span: 0.5},
        {label: 'As at', kind: 'date', span: 0.5},
      ]},
      signatures('Landlord signature', 'Tenant signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'transfer-on-death-deed': {
    title: 'Transfer on death deed',
    subtitle: 'Names who receives the property when the owner dies, without probate',
    sections: [
      {title: 'Owner', fields: [
        {label: 'Full name', span: 1},
        {label: 'Address', span: 1},
        {label: 'City', span: 0.5}, {label: 'Postcode', span: 0.5},
      ]},
      {title: 'The property', fields: [
        {label: 'Property address', span: 1},
        {label: 'County', span: 0.5}, {label: 'Parcel or tax number', span: 0.5},
        {label: 'Legal description', kind: 'multiline'},
      ]},
      {title: 'Beneficiary', fields: [
        {label: 'Primary beneficiary', span: 0.5}, {label: 'Relationship', span: 0.5},
        {label: 'Beneficiary address', span: 1},
        {label: 'Alternate beneficiary', span: 0.5}, {label: 'Relationship ', span: 0.5},
      ]},
      {title: 'Revocability', note:
        'A transfer on death deed takes effect only on death and can be revoked at any time before then.',
       fields: [
        {label: 'This deed revokes any earlier transfer on death deed for this property',
         kind: 'check', span: 1, hint: 'Tick to confirm'},
      ]},
      {title: 'Notary', fields: [
        {label: 'State', span: 0.5}, {label: 'County ', span: 0.5},
        {label: 'Notary signature', kind: 'signature', span: 0.5},
        {label: 'Commission expires', kind: 'date', span: 0.5},
      ]},
      signatures('Owner signature'),
    ],
    footnote: NOT_ADVICE
      + ' Transfer on death deeds are not recognised in every state, and where they are they must usually be'
      + ' notarised and recorded with the county before the owner dies to have any effect at all.',
  },

  'marital-settlement-agreement': {
    title: 'Marital settlement agreement',
    subtitle: 'How a separating couple divide property, debts and the care of children',
    sections: [
      {title: 'The parties', fields: [
        {label: 'First spouse full name', span: 0.5}, {label: 'Second spouse full name', span: 0.5},
        {label: 'Date of marriage', kind: 'date', span: 0.5},
        {label: 'Date of separation', kind: 'date', span: 0.5},
        {label: 'County and state', span: 1},
      ]},
      {title: 'Property', fields: [
        {label: 'Real property and who keeps it', kind: 'multiline'},
        {label: 'Vehicles', kind: 'multiline'},
        {label: 'Bank and retirement accounts', kind: 'multiline'},
        {label: 'Household goods', kind: 'multiline'},
      ]},
      {title: 'Debts', fields: [
        {label: 'Debts and who pays them', kind: 'multiline'},
      ]},
      {title: 'Support', fields: [
        {label: 'Spousal support amount', kind: 'money', span: 0.5},
        {label: 'Paid until', kind: 'date', span: 0.5},
        {label: 'Child support amount', kind: 'money', span: 0.5},
        {label: 'Paid by', span: 0.5},
      ]},
      {title: 'Children', fields: [
        {label: 'Children and dates of birth', kind: 'multiline'},
        {label: 'Legal custody', span: 0.5}, {label: 'Physical custody', span: 0.5},
        {label: 'Parenting time', kind: 'multiline'},
      ]},
      signatures('First spouse signature', 'Second spouse signature'),
    ],
    footnote: NOT_ADVICE
      + ' A settlement agreement usually has to be approved by the court handling the divorce, and terms about'
      + ' children are decided on the child’s interests whatever the parents agree between themselves.',
  },

  'receipt': {
    title: 'Payment receipt',
    subtitle: 'Proof that money changed hands',
    sections: [
      {title: 'Receipt', fields: [
        {label: 'Receipt number', span: 0.5}, {label: 'Date', kind: 'date', span: 0.5},
      ]},
      {title: 'Received from', fields: [
        {label: 'Name', span: 0.5}, {label: 'Phone or email', span: 0.5},
        {label: 'Address', span: 1},
      ]},
      {title: 'Received by', fields: [
        {label: 'Name ', span: 0.5}, {label: 'Business', span: 0.5},
        {label: 'Address ', span: 1},
      ]},
      {title: 'The payment', fields: [
        {label: 'Amount', kind: 'money', span: 0.5},
        {label: 'Method', span: 0.5, hint: 'Cash, card, transfer'},
        {label: 'What it is for', kind: 'multiline'},
        {label: 'Balance still owing', kind: 'money', span: 0.5},
        {label: 'Paid in full', kind: 'check', span: 0.5, hint: 'Tick if nothing remains'},
      ]},
      signatures('Received by signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'bill-of-lading': {
    title: 'Bill of lading',
    subtitle: 'The receipt and contract that travels with a shipment',
    sections: [
      {title: 'Shipment', fields: [
        {label: 'Bill of lading number', span: 0.5}, {label: 'Date', kind: 'date', span: 0.5},
        {label: 'Carrier', span: 0.5}, {label: 'Trailer or container number', span: 0.5},
      ]},
      {title: 'Shipper', fields: [
        {label: 'Name', span: 0.5}, {label: 'Phone', span: 0.5},
        {label: 'Address', span: 1},
      ]},
      {title: 'Consignee', fields: [
        {label: 'Name ', span: 0.5}, {label: 'Phone ', span: 0.5},
        {label: 'Address ', span: 1},
      ]},
      {title: 'The goods', fields: [
        {label: 'Number of packages', span: 0.25}, {label: 'Type of packaging', span: 0.25},
        {label: 'Weight', span: 0.25}, {label: 'Class', span: 0.25},
        {label: 'Description of goods', kind: 'multiline'},
        {label: 'Declared value', kind: 'money', span: 0.5},
        {label: 'Hazardous materials', kind: 'check', span: 0.5, hint: 'Tick if any'},
      ]},
      {title: 'Charges', fields: [
        {label: 'Freight charges', kind: 'money', span: 0.5},
        {label: 'Prepaid or collect', span: 0.5},
      ]},
      signatures('Shipper signature', 'Carrier signature'),
    ],
    footnote: NOT_ADVICE
      + ' Hazardous shipments carry labelling and paperwork rules of their own that this template does not cover.',
  },

  'employment-separation-certificate': {
    title: 'Employment separation certificate',
    subtitle: 'What an employer records when someone leaves',
    sections: [
      {title: 'Employer', fields: [
        {label: 'Business name', span: 0.5}, {label: 'Contact', span: 0.5},
        {label: 'Address', span: 1},
      ]},
      {title: 'Employee', fields: [
        {label: 'Full name', span: 0.5}, {label: 'Job title', span: 0.5},
        {label: 'Start date', kind: 'date', span: 0.5}, {label: 'Last day worked', kind: 'date', span: 0.5},
      ]},
      {title: 'Reason for leaving', fields: [
        {label: 'Resigned', kind: 'check', span: 0.5}, {label: 'Made redundant', kind: 'check', span: 0.5},
        {label: 'Dismissed', kind: 'check', span: 0.5}, {label: 'Contract ended', kind: 'check', span: 0.5},
        {label: 'Details', kind: 'multiline'},
      ]},
      {title: 'Final pay', fields: [
        {label: 'Final gross pay', kind: 'money', span: 0.5},
        {label: 'Date paid', kind: 'date', span: 0.5},
        {label: 'Unused leave paid out', kind: 'money', span: 0.5},
        {label: 'Severance', kind: 'money', span: 0.5},
      ]},
      signatures('Employer signature', 'Employee signature'),
    ],
    footnote: NOT_ADVICE
      + ' What an employer may state about a departure, and what has to be paid out on the last day, is set by'
      + ' the employment law of the place the job was in.',
  },

  'credit-dispute-letter': {
    title: 'Credit report dispute letter',
    subtitle: 'Asks a credit bureau to correct something that is wrong',
    sections: [
      {title: 'From', fields: [
        {label: 'Full name', span: 0.5}, {label: 'Date of birth', kind: 'date', span: 0.5},
        {label: 'Address', span: 1},
        {label: 'Phone', span: 0.5}, {label: 'Last four of SSN', span: 0.5},
      ]},
      {title: 'To', fields: [
        {label: 'Credit bureau', span: 0.5, hint: 'Equifax, Experian, TransUnion'},
        {label: 'Date', kind: 'date', span: 0.5},
        {label: 'Report or file number', span: 1},
      ]},
      {title: 'What is wrong', note:
        'Name the account, say what the report claims, and say what is actually true.',
       fields: [
        {label: 'Account or creditor name', span: 0.5}, {label: 'Account number', span: 0.5},
        {label: 'What the report says', kind: 'multiline'},
        {label: 'What is correct, and why', kind: 'multiline'},
        {label: 'Documents enclosed', kind: 'multiline'},
      ]},
      {title: 'What I am asking for', fields: [
        {label: 'Correct the entry', kind: 'check', span: 0.5},
        {label: 'Delete the entry', kind: 'check', span: 0.5},
        {label: 'Send me a corrected copy of the report', kind: 'check', span: 1},
      ]},
      signatures('Signature'),
    ],
    footnote: NOT_ADVICE
      + ' In the United States the Fair Credit Reporting Act gives a bureau 30 days to investigate a written'
      + ' dispute. Send it so you can prove it arrived, and keep a copy of everything you enclose.',
  },

  'profit-and-loss-statement': {
    title: 'Profit and loss statement',
    subtitle: 'What came in, what went out, and what is left',
    sections: [
      {title: 'The business and period', fields: [
        {label: 'Business name', span: 0.5}, {label: 'Prepared by', span: 0.5},
        {label: 'Period from', kind: 'date', span: 0.5}, {label: 'Period to', kind: 'date', span: 0.5},
      ]},
      {title: 'Income', fields: [
        {label: 'Sales or services', kind: 'money', span: 0.5},
        {label: 'Other income', kind: 'money', span: 0.5},
        {label: 'Returns and allowances', kind: 'money', span: 0.5},
        {label: 'Total income', kind: 'money', span: 0.5},
      ]},
      {title: 'Cost of goods sold', fields: [
        {label: 'Materials and stock', kind: 'money', span: 0.5},
        {label: 'Direct labour', kind: 'money', span: 0.5},
        {label: 'Total cost of goods', kind: 'money', span: 0.5},
        {label: 'Gross profit', kind: 'money', span: 0.5},
      ]},
      {title: 'Expenses', fields: [
        {label: 'Wages', kind: 'money', span: 0.5}, {label: 'Rent', kind: 'money', span: 0.5},
        {label: 'Utilities', kind: 'money', span: 0.5}, {label: 'Insurance', kind: 'money', span: 0.5},
        {label: 'Marketing', kind: 'money', span: 0.5}, {label: 'Professional fees', kind: 'money', span: 0.5},
        {label: 'Travel', kind: 'money', span: 0.5}, {label: 'Depreciation', kind: 'money', span: 0.5},
        {label: 'Other expenses', kind: 'money', span: 0.5}, {label: 'Total expenses', kind: 'money', span: 0.5},
      ]},
      {title: 'Result', fields: [
        {label: 'Net profit or loss', kind: 'money', span: 0.5},
        {label: 'Notes', span: 0.5},
      ]},
      signatures('Prepared by signature'),
    ],
    footnote: NOT_ADVICE,
  },

  'esa-letter': {
    title: 'Emotional support animal letter',
    subtitle: 'Written by a licensed clinician for a patient in their care',
    sections: [
      {title: 'Clinician', note:
        'Only a licensed mental health professional who is treating the patient can write this.',
       fields: [
        {label: 'Name', span: 0.5}, {label: 'Licence type and number', span: 0.5},
        {label: 'State of licence', span: 0.5}, {label: 'Licence expires', kind: 'date', span: 0.5},
        {label: 'Practice address', span: 1},
        {label: 'Phone', span: 0.5}, {label: 'Email', span: 0.5},
      ]},
      {title: 'Patient', fields: [
        {label: 'Full name', span: 0.5}, {label: 'Patient since', kind: 'date', span: 0.5},
        {label: 'Address', span: 1},
      ]},
      {title: 'The animal', fields: [
        {label: 'Species', span: 0.5}, {label: 'Name', span: 0.5},
      ]},
      {title: 'The clinician’s statement', fields: [
        {label: 'How the animal helps with the patient’s condition', kind: 'multiline'},
        {label: 'I am treating this patient and recommend the animal as part of that treatment',
         kind: 'check', span: 1, hint: 'Tick to confirm'},
        {label: 'Valid until', kind: 'date', span: 0.5},
      ]},
      signatures('Clinician signature'),
    ],
    footnote: NOT_ADVICE
      + ' An emotional support animal is not a service animal and has no public-access rights. Since 2021 US'
      + ' airlines have not been required to carry one. A letter counts for anything only when a clinician who'
      + ' genuinely treats you writes it — letters bought online are routinely rejected.',
  },
};

export const specFor = (slug: string): FormSpec | undefined => FORM_SPECS[slug];
