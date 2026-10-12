// AICPA 2017 Trust Services Criteria for Security, Availability, Processing
// Integrity, Confidentiality, and Privacy (with Revised Points of Focus - 2022).
// The 2022 revision changed only the points of focus, not the criteria, so this
// is the full official criteria list. Used to verify the SOC 2 seed data.

export interface TrustServicesCriterion {
  identifier: string;
  category: string;
  text: string;
}

const OBJ = "to meet the entity's objectives";
const PRIV = "to meet the entity's objectives related to privacy";

const criterion = (identifier: string, category: string, text: string) => ({
  identifier,
  category,
  text,
});

const CONTROL_ENV = 'Control Environment';
const INFO_COMM = 'Communication and Information';
const RISK_ASSESS = 'Risk Assessment';
const MONITORING = 'Monitoring Activities';
const CONTROL_ACT = 'Control Activities';
const ACCESS = 'Logical and Physical Access Controls';
const SYS_OPS = 'System Operations';

export const TSC_2017_CRITERIA: readonly TrustServicesCriterion[] = [
  criterion('CC1.1', CONTROL_ENV, 'COSO Principle 1: The entity demonstrates a commitment to integrity and ethical values.'),
  criterion('CC1.2', CONTROL_ENV, 'COSO Principle 2: The board of directors demonstrates independence from management and exercises oversight of the development and performance of internal control.'),
  criterion('CC1.3', CONTROL_ENV, 'COSO Principle 3: Management establishes, with board oversight, structures, reporting lines, and appropriate authorities and responsibilities in the pursuit of objectives.'),
  criterion('CC1.4', CONTROL_ENV, 'COSO Principle 4: The entity demonstrates a commitment to attract, develop, and retain competent individuals in alignment with objectives.'),
  criterion('CC1.5', CONTROL_ENV, 'COSO Principle 5: The entity holds individuals accountable for their internal control responsibilities in the pursuit of objectives.'),
  criterion('CC2.1', INFO_COMM, 'COSO Principle 13: The entity obtains or generates and uses relevant, quality information to support the functioning of internal control.'),
  criterion('CC2.2', INFO_COMM, 'COSO Principle 14: The entity internally communicates information, including objectives and responsibilities for internal control, necessary to support the functioning of internal control.'),
  criterion('CC2.3', INFO_COMM, 'COSO Principle 15: The entity communicates with external parties regarding matters affecting the functioning of internal control.'),
  criterion('CC3.1', RISK_ASSESS, 'COSO Principle 6: The entity specifies objectives with sufficient clarity to enable the identification and assessment of risks relating to objectives.'),
  criterion('CC3.2', RISK_ASSESS, 'COSO Principle 7: The entity identifies risks to the achievement of its objectives across the entity and analyzes risks as a basis for determining how the risks should be managed.'),
  criterion('CC3.3', RISK_ASSESS, 'COSO Principle 8: The entity considers the potential for fraud in assessing risks to the achievement of objectives.'),
  criterion('CC3.4', RISK_ASSESS, 'COSO Principle 9: The entity identifies and assesses changes that could significantly impact the system of internal control.'),
  criterion('CC4.1', MONITORING, 'COSO Principle 16: The entity selects, develops, and performs ongoing and/or separate evaluations to ascertain whether the components of internal control are present and functioning.'),
  criterion('CC4.2', MONITORING, 'COSO Principle 17: The entity evaluates and communicates internal control deficiencies in a timely manner to those parties responsible for taking corrective action, including senior management and the board of directors, as appropriate.'),
  criterion('CC5.1', CONTROL_ACT, 'COSO Principle 10: The entity selects and develops control activities that contribute to the mitigation of risks to the achievement of objectives to acceptable levels.'),
  criterion('CC5.2', CONTROL_ACT, 'COSO Principle 11: The entity also selects and develops general control activities over technology to support the achievement of objectives.'),
  criterion('CC5.3', CONTROL_ACT, 'COSO Principle 12: The entity deploys control activities through policies that establish what is expected and in procedures that put policies into action.'),
  criterion('CC6.1', ACCESS, `The entity implements logical access security software, infrastructure, and architectures over protected information assets to protect them from security events ${OBJ}.`),
  criterion('CC6.2', ACCESS, 'Prior to issuing system credentials and granting system access, the entity registers and authorizes new internal and external users whose access is administered by the entity. For those users whose access is administered by the entity, user system credentials are removed when user access is no longer authorized.'),
  criterion('CC6.3', ACCESS, `The entity authorizes, modifies, or removes access to data, software, functions, and other protected information assets based on roles, responsibilities, or the system design and changes, giving consideration to the concepts of least privilege and segregation of duties, ${OBJ}.`),
  criterion('CC6.4', ACCESS, `The entity restricts physical access to facilities and protected information assets (for example, data center facilities, back-up media storage, and other sensitive locations) to authorized personnel ${OBJ}.`),
  criterion('CC6.5', ACCESS, `The entity discontinues logical and physical protections over physical assets only after the ability to read or recover data and software from those assets has been diminished and is no longer required ${OBJ}.`),
  criterion('CC6.6', ACCESS, 'The entity implements logical access security measures to protect against threats from sources outside its system boundaries.'),
  criterion('CC6.7', ACCESS, `The entity restricts the transmission, movement, and removal of information to authorized internal and external users and processes, and protects it during transmission, movement, or removal ${OBJ}.`),
  criterion('CC6.8', ACCESS, `The entity implements controls to prevent or detect and act upon the introduction of unauthorized or malicious software ${OBJ}.`),
  criterion('CC7.1', SYS_OPS, 'To meet its objectives, the entity uses detection and monitoring procedures to identify (1) changes to configurations that result in the introduction of new vulnerabilities, and (2) susceptibilities to newly discovered vulnerabilities.'),
  criterion('CC7.2', SYS_OPS, "The entity monitors system components and the operation of those components for anomalies that are indicative of malicious acts, natural disasters, and errors affecting the entity's ability to meet its objectives; anomalies are analyzed to determine whether they represent security events."),
  criterion('CC7.3', SYS_OPS, 'The entity evaluates security events to determine whether they could or have resulted in a failure of the entity to meet its objectives (security incidents) and, if so, takes actions to prevent or address such failures.'),
  criterion('CC7.4', SYS_OPS, 'The entity responds to identified security incidents by executing a defined incident response program to understand, contain, remediate, and communicate security incidents, as appropriate.'),
  criterion('CC7.5', SYS_OPS, 'The entity identifies, develops, and implements activities to recover from identified security incidents.'),
  criterion('CC8.1', 'Change Management', 'The entity authorizes, designs, develops or acquires, configures, documents, tests, approves, and implements changes to infrastructure, data, software, and procedures to meet its objectives.'),
  criterion('CC9.1', 'Risk Mitigation', 'The entity identifies, selects, and develops risk mitigation activities for risks arising from potential business disruptions.'),
  criterion('CC9.2', 'Risk Mitigation', 'The entity assesses and manages risks associated with vendors and business partners.'),
  criterion('A1.1', 'Availability', 'The entity maintains, monitors, and evaluates current processing capacity and use of system components (infrastructure, data, and software) to manage capacity demand and to enable the implementation of additional capacity to help meet its objectives.'),
  criterion('A1.2', 'Availability', 'The entity authorizes, designs, develops or acquires, implements, operates, approves, maintains, and monitors environmental protections, software, data back-up processes, and recovery infrastructure to meet its objectives.'),
  criterion('A1.3', 'Availability', 'The entity tests recovery plan procedures supporting system recovery to meet its objectives.'),
  criterion('C1.1', 'Confidentiality', `The entity identifies and maintains confidential information ${OBJ} related to confidentiality.`),
  criterion('C1.2', 'Confidentiality', `The entity disposes of confidential information ${OBJ} related to confidentiality.`),
  criterion('PI1.1', 'Processing Integrity', 'The entity obtains or generates, uses, and communicates relevant, quality information regarding the objectives related to processing, including definitions of data processed and product and service specifications, to support the use of products and services.'),
  criterion('PI1.2', 'Processing Integrity', `The entity implements policies and procedures over system inputs, including controls over completeness and accuracy, to result in products, services, and reporting ${OBJ}.`),
  criterion('PI1.3', 'Processing Integrity', `The entity implements policies and procedures over system processing to result in products, services, and reporting ${OBJ}.`),
  criterion('PI1.4', 'Processing Integrity', `The entity implements policies and procedures to make available or deliver output completely, accurately, and timely in accordance with specifications ${OBJ}.`),
  criterion('PI1.5', 'Processing Integrity', `The entity implements policies and procedures to store inputs, items in processing, and outputs completely, accurately, and timely in accordance with system specifications ${OBJ}.`),
  criterion('P1.1', 'Privacy - Notice and Communication of Objectives', `The entity provides notice to data subjects about its privacy practices ${PRIV}. The notice is updated and communicated to data subjects in a timely manner for changes to the entity's privacy practices, including changes in the use of personal information, ${PRIV}.`),
  criterion('P2.1', 'Privacy - Choice and Consent', `The entity communicates choices available regarding the collection, use, retention, disclosure, and disposal of personal information to the data subjects and the consequences, if any, of each choice. Explicit consent for the collection, use, retention, disclosure, and disposal of personal information is obtained from data subjects or other authorized persons, if required. Such consent is obtained only for the intended purpose of the information ${PRIV}. The entity's basis for determining implicit consent for the collection, use, retention, disclosure, and disposal of personal information is documented.`),
  criterion('P3.1', 'Privacy - Collection', "Personal information is collected consistent with the entity's objectives related to privacy."),
  criterion('P3.2', 'Privacy - Collection', `For information requiring explicit consent, the entity communicates the need for such consent, as well as the consequences of a failure to provide consent for the request for personal information, and obtains the consent prior to the collection of the information ${PRIV}.`),
  criterion('P4.1', 'Privacy - Use, Retention, and Disposal', "The entity limits the use of personal information to the purposes identified in the entity's objectives related to privacy."),
  criterion('P4.2', 'Privacy - Use, Retention, and Disposal', "The entity retains personal information consistent with the entity's objectives related to privacy."),
  criterion('P4.3', 'Privacy - Use, Retention, and Disposal', `The entity securely disposes of personal information ${PRIV}.`),
  criterion('P5.1', 'Privacy - Access', `The entity grants identified and authenticated data subjects the ability to access their stored personal information for review and, upon request, provides physical or electronic copies of that information to data subjects ${PRIV}. If access is denied, data subjects are informed of the denial and reason for such denial, as required, ${PRIV}.`),
  criterion('P5.2', 'Privacy - Access', `The entity corrects, amends, or appends personal information based on information provided by data subjects and communicates such information to third parties, as committed or required, ${PRIV}. If a request for correction is denied, data subjects are informed of the denial and reason for such denial ${PRIV}.`),
  criterion('P6.1', 'Privacy - Disclosure and Notification', `The entity discloses personal information to third parties with the explicit consent of data subjects, and such consent is obtained prior to disclosure ${PRIV}.`),
  criterion('P6.2', 'Privacy - Disclosure and Notification', `The entity creates and retains a complete, accurate, and timely record of authorized disclosures of personal information ${PRIV}.`),
  criterion('P6.3', 'Privacy - Disclosure and Notification', `The entity creates and retains a complete, accurate, and timely record of detected or reported unauthorized disclosures (including breaches) of personal information ${PRIV}.`),
  criterion('P6.4', 'Privacy - Disclosure and Notification', `The entity obtains privacy commitments from vendors and other third parties who have access to personal information ${PRIV}. The entity assesses those parties' compliance on a periodic and as-needed basis and takes corrective action, if necessary.`),
  criterion('P6.5', 'Privacy - Disclosure and Notification', `The entity obtains commitments from vendors and other third parties with access to personal information to notify the entity in the event of actual or suspected unauthorized disclosures of personal information. Such notifications are reported to appropriate personnel and acted on in accordance with established incident response procedures ${PRIV}.`),
  criterion('P6.6', 'Privacy - Disclosure and Notification', `The entity provides notification of breaches and incidents to affected data subjects, regulators, and others ${PRIV}.`),
  criterion('P6.7', 'Privacy - Disclosure and Notification', `The entity provides data subjects with an accounting of the personal information held and disclosure of the data subjects' personal information, upon the data subjects' request, ${PRIV}.`),
  criterion('P7.1', 'Privacy - Quality', `The entity collects and maintains accurate, up-to-date, complete, and relevant personal information ${PRIV}.`),
  criterion('P8.1', 'Privacy - Monitoring and Enforcement', `The entity implements a process for receiving, addressing, resolving, and communicating the resolution of inquiries, complaints, and disputes from data subjects and others and periodically monitors compliance ${PRIV}. Corrections and other necessary actions related to identified deficiencies are made or taken in a timely manner.`),
];
