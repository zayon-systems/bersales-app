// Bersales — templates.js
//
// Document category + PH government-document type templates. Selecting a
// type tells the app what fields to ask for and, in reminders.js, drives
// the default reminder behavior. This is intentionally data, not logic —
// add a new document type by adding an entry here.

const CATEGORIES = [
  { id: 'government', label: 'Government' },
  { id: 'employment', label: 'Employment' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'property', label: 'Property' },
  { id: 'education', label: 'Education' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'business', label: 'Business' },
  { id: 'medical', label: 'Medical' },
  { id: 'warranty', label: 'Warranty' },
  { id: 'other', label: 'Other' }
];

// Each doc type: fields (rendered as form inputs, in order) + which field
// holds the expiry date (if any — warranties/receipts may have none).
const DOC_TYPES = {
  philippine_passport: {
    label: 'Philippine Passport',
    category: 'government',
    fields: ['fullName', 'passportNumber', 'issueDate', 'expiryDate', 'issuingAgency'],
    expiryField: 'expiryDate'
  },
  drivers_license: {
    label: "Driver's License",
    category: 'government',
    fields: ['fullName', 'licenseNumber', 'licenseClassification', 'issueDate', 'expiryDate', 'restrictions'],
    expiryField: 'expiryDate'
  },
  prc_license: {
    label: 'PRC License',
    category: 'government',
    fields: ['fullName', 'licenseNumber', 'profession', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  nbi_clearance: {
    label: 'NBI Clearance',
    category: 'government',
    fields: ['fullName', 'referenceNumber', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  police_clearance: {
    label: 'Police Clearance',
    category: 'government',
    fields: ['fullName', 'referenceNumber', 'issueDate', 'expiryDate', 'issuingAgency'],
    expiryField: 'expiryDate'
  },
  national_id: {
    label: 'National ID / PhilSys',
    category: 'government',
    fields: ['fullName', 'psnOrCardNumber', 'issueDate'],
    expiryField: null
  },
  postal_id: {
    label: 'Postal ID',
    category: 'government',
    fields: ['fullName', 'idNumber', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  tin: {
    label: 'TIN Document',
    category: 'government',
    fields: ['fullName', 'tinNumber', 'issueDate'],
    expiryField: null
  },
  sss: {
    label: 'SSS Document',
    category: 'government',
    fields: ['fullName', 'sssNumber', 'issueDate'],
    expiryField: null
  },
  philhealth: {
    label: 'PhilHealth',
    category: 'government',
    fields: ['fullName', 'philhealthNumber', 'issueDate'],
    expiryField: null
  },
  pagibig: {
    label: 'Pag-IBIG',
    category: 'government',
    fields: ['fullName', 'pagibigNumber', 'issueDate'],
    expiryField: null
  },
  umid: {
    label: 'Unified Multipurpose ID (UMID)',
    category: 'government',
    fields: ['fullName', 'umidNumber', 'issueDate'],
    expiryField: null
  },
  vehicle_registration: {
    label: 'Vehicle Registration (OR/CR)',
    category: 'vehicle',
    fields: ['ownerName', 'plateNumber', 'orNumber', 'crNumber', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  business_permit: {
    label: 'Business Permit',
    category: 'business',
    fields: ['businessName', 'permitNumber', 'issueDate', 'expiryDate', 'issuingAgency'],
    expiryField: 'expiryDate'
  },
  barangay_document: {
    label: 'Barangay Document',
    category: 'government',
    fields: ['fullName', 'documentType', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  professional_certificate: {
    label: 'Professional Certificate',
    category: 'education',
    fields: ['fullName', 'certificateTitle', 'issuingBody', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  insurance_policy: {
    label: 'Insurance Policy',
    category: 'insurance',
    fields: ['policyHolder', 'policyNumber', 'provider', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  warranty: {
    label: 'Warranty',
    category: 'warranty',
    fields: ['itemName', 'store', 'purchaseDate', 'warrantyExpiry', 'amount'],
    expiryField: 'warrantyExpiry'
  },
  receipt: {
    label: 'Receipt / Invoice',
    category: 'other',
    fields: ['itemName', 'store', 'purchaseDate', 'amount'],
    expiryField: null
  },
  company_id: {
    label: 'Company / Employee ID',
    category: 'employment',
    fields: ['fullName', 'employeeIdNumber', 'company', 'position', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  school_id: {
    label: 'School ID',
    category: 'education',
    fields: ['fullName', 'studentIdNumber', 'school', 'schoolYear', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  membership_id: {
    label: 'Membership / Association ID',
    category: 'other',
    fields: ['fullName', 'membershipNumber', 'organization', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  health_card: {
    label: 'HMO / Health Card',
    category: 'medical',
    fields: ['fullName', 'memberNumber', 'provider', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  // LTOPF, Firearm Registration, and PTCFOR all reuse the shared 'issueDate'/
  // 'expiryDate' field keys (so ocr.js's date-guessing heuristic and the
  // isDate-detection in buildForm() keep working the same as every other
  // document type), but each wants its own wording on the card rather than
  // the generic "Issue Date"/"Expiry Date" every other type shows. That's
  // what the optional `fieldLabels` map below is for: buildForm() checks it
  // before falling back to the global FIELD_LABELS, so the override is
  // purely cosmetic and never affects what key the value is actually stored
  // under.
  ltopf: {
    label: 'LTOPF (License to Own and Possess Firearm)',
    category: 'government',
    fields: ['ltopfNumber', 'qualification', 'issueDate', 'expiryDate'],
    fieldLabels: { ltopfNumber: 'LTOPF ID', issueDate: 'Date Approved', expiryDate: 'Expiration Date' },
    expiryField: 'expiryDate'
  },
  gun_registration: {
    label: 'Firearm Registration',
    category: 'government',
    fields: ['fullName', 'makeModel', 'caliber', 'serialNumber', 'issueDate', 'expiryDate'],
    fieldLabels: { issueDate: 'Card Printed Date' },
    expiryField: 'expiryDate'
  },
  ptcfor: {
    label: 'PTCFOR (Permit to Carry Firearm Outside Residence)',
    category: 'government',
    fields: ['controlNumber', 'serialNumber', 'kind', 'make', 'caliber', 'issueDate', 'expiryDate'],
    fieldLabels: { issueDate: 'Date Issued', expiryDate: 'Expiration Date' },
    expiryField: 'expiryDate'
  },
  dti_business_registration: {
    label: 'DTI Business Name Registration',
    category: 'business',
    fields: ['businessName', 'certificateNumber', 'scope', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  bir_registration: {
    label: 'BIR Certificate of Registration (2303)',
    category: 'business',
    fields: ['businessName', 'tinNumber', 'rdoCode', 'registeredAddress', 'issueDate'],
    expiryField: null
  },
  senior_citizen_id: {
    label: 'Senior Citizen ID',
    category: 'government',
    fields: ['fullName', 'idNumber', 'issuingAgency', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  pwd_id: {
    label: 'PWD ID',
    category: 'government',
    fields: ['fullName', 'idNumber', 'disabilityType', 'issuingAgency', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  barangay_clearance: {
    label: 'Barangay Clearance',
    category: 'government',
    fields: ['fullName', 'controlNumber', 'issuingBarangay', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  barangay_id: {
    label: 'Barangay ID',
    category: 'government',
    fields: ['fullName', 'idNumber', 'issuingBarangay', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  subdivision_id: {
    label: 'Subdivision / HOA ID',
    category: 'other',
    fields: ['fullName', 'idNumber', 'subdivisionName', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  residence_id: {
    label: 'Residence ID',
    category: 'other',
    fields: ['fullName', 'idNumber', 'issuingAuthority', 'address', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  custom_id: {
    label: 'Other ID (Custom)',
    category: 'other',
    fields: ['idLabel', 'fullName', 'idNumber', 'issuingAuthority', 'issueDate', 'expiryDate'],
    expiryField: 'expiryDate'
  },
  medical_record: {
    label: 'Medical Record',
    category: 'medical',
    fields: ['fullName', 'recordType', 'doctorOrFacility', 'recordDate', 'notes'],
    expiryField: null
  },
  other: {
    label: 'Other Document',
    category: 'other',
    fields: ['title', 'issueDate', 'expiryDate', 'notes'],
    expiryField: 'expiryDate'
  }
};

const FIELD_LABELS = {
  fullName: 'Full Name',
  passportNumber: 'Passport Number',
  licenseNumber: 'License Number',
  licenseClassification: 'License Classification',
  issueDate: 'Issue Date',
  expiryDate: 'Expiry Date',
  issuingAgency: 'Issuing Agency',
  restrictions: 'Restrictions',
  profession: 'Profession',
  referenceNumber: 'Reference Number',
  psnOrCardNumber: 'PSN / Card Number',
  idNumber: 'ID Number',
  tinNumber: 'TIN',
  sssNumber: 'SSS Number',
  philhealthNumber: 'PhilHealth Number',
  pagibigNumber: 'Pag-IBIG Number',
  umidNumber: 'UMID Number',
  ownerName: "Owner's Name",
  plateNumber: 'Plate Number',
  orNumber: 'OR Number',
  crNumber: 'CR Number',
  businessName: 'Business Name',
  permitNumber: 'Permit Number',
  documentType: 'Document Type',
  certificateTitle: 'Certificate Title',
  issuingBody: 'Issuing Body',
  policyHolder: 'Policy Holder',
  policyNumber: 'Policy Number',
  provider: 'Provider',
  itemName: 'Item Name',
  store: 'Store',
  purchaseDate: 'Purchase Date',
  warrantyExpiry: 'Warranty Expiry',
  amount: 'Amount',
  title: 'Title',
  notes: 'Notes',
  employeeIdNumber: 'Employee ID Number',
  company: 'Company',
  position: 'Position',
  studentIdNumber: 'Student ID Number',
  school: 'School',
  schoolYear: 'School Year',
  membershipNumber: 'Membership Number',
  organization: 'Organization',
  memberNumber: 'Member Number',
  ltopfNumber: 'LTOPF Number', // default label; ltopf's own template overrides this to "LTOPF ID" via fieldLabels
  makeModel: 'Make / Model',
  caliber: 'Caliber',
  serialNumber: 'Serial Number',
  kind: 'Kind',
  make: 'Make',
  qualification: 'Qualification',
  certificateNumber: 'Certificate Number',
  scope: 'Scope (Barangay / City / Regional / National)',
  rdoCode: 'RDO Code',
  registeredAddress: 'Registered Address',
  disabilityType: 'Disability Type',
  controlNumber: 'Control Number',
  issuingBarangay: 'Issuing Barangay',
  subdivisionName: 'Subdivision / HOA Name',
  address: 'Address',
  issuingAuthority: 'Issuing Authority',
  idLabel: 'What kind of ID is this?',
  recordType: 'Record Type',
  doctorOrFacility: 'Doctor / Facility',
  recordDate: 'Record Date'
};
