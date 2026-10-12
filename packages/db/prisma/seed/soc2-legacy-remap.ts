// How each of the 74 original "SOC 2" 1.0.0 (frk_681ebae2f29f0ab08eb802ec)
// requirement records maps onto the official TSC 2017 criteria.
//
// A record keeps its id when its content describes an official criterion, even
// if it carried the wrong number ("renumbered"), because customer RequirementMap
// rows reference these ids and follow the record's meaning. Records with no
// criterion of their own (invented criteria, or a second record for the same
// criterion) are "retired": removed from the seed, with any control mapped to
// them belonging under `criterion` instead.

export type LegacyRecordAction = 'kept' | 'renumbered' | 'retired';

export interface LegacyRecordRemap {
  id: string;
  oldLabel: string;
  criterion: string;
  action: LegacyRecordAction;
}

const remap = (
  id: string,
  oldLabel: string,
  criterion: string,
  action: LegacyRecordAction,
): LegacyRecordRemap => ({ id, oldLabel, criterion, action });

export const SOC2_LEGACY_REMAP: readonly LegacyRecordRemap[] = [
  remap('frk_rq_681ebb934dd08b250907c515', 'CC1.1', 'CC1.1', 'kept'),
  remap('frk_rq_681ebba6f55e177eef990bf7', 'CC1.2', 'CC1.2', 'kept'),
  remap('frk_rq_681ebbc3efb5a2e1ef0ab09c', 'CC1.3', 'CC1.3', 'kept'),
  remap('frk_rq_681ebbd6d5b5789fb766bb2c', 'CC1.4', 'CC1.4', 'kept'),
  remap('frk_rq_681ebbfb12867521d3d28cde', 'CC1.5', 'CC1.5', 'kept'),
  remap('frk_rq_681ebc1cc593f19b23a68a02', 'CC2.1', 'CC2.1', 'kept'),
  remap('frk_rq_681ebc3664f286e865b059c2', 'CC2.2', 'CC2.2', 'kept'),
  remap('frk_rq_681ebc435c7f4032133c00ff', 'CC2.3', 'CC2.3', 'kept'),
  // "Communicate intellectual-property & privacy commitments" - external communication.
  remap('frk_rq_681ebc52d1ea4fe58854791a', 'CC2.4', 'CC2.3', 'retired'),
  remap('frk_rq_681ebc6f2c5620696001f688', 'CC3.1', 'CC3.1', 'kept'),
  remap('frk_rq_681ebc8489a15319d49a13d3', 'CC3.2', 'CC3.2', 'kept'),
  remap('frk_rq_681ebc97bfb5120143dabe4e', 'CC3.3', 'CC3.3', 'kept'),
  remap('frk_rq_681ebcafedeabed06a31d782', 'CC3.4', 'CC3.4', 'kept'),
  remap('frk_rq_681ebcc6bf10668a7b6e4da1', 'CC4.1', 'CC4.1', 'kept'),
  remap('frk_rq_681ebce6a256e65326eb21b2', 'CC4.2', 'CC4.2', 'kept'),
  remap('frk_rq_681ebcf14b5cb5842b2af09b', 'CC5.1', 'CC5.1', 'kept'),
  remap('frk_rq_681ebd036f42d17b6e1ad003', 'CC5.2', 'CC5.2', 'kept'),
  remap('frk_rq_681ebd110860fdae08078d1e', 'CC5.3', 'CC5.3', 'kept'),
  // "Manage controls over third-party relationships" - vendor risk.
  remap('frk_rq_681ebd2e5fcf443f7d40fd3d', 'CC5.4', 'CC9.2', 'retired'),
  // "Enforce controls over end-user devices" - endpoint protection.
  remap('frk_rq_681ebd3ae3397498f9ec9f66', 'CC5.5', 'CC6.8', 'retired'),
  // "Provisioning of logical and physical access is authorized."
  remap('frk_rq_681ebea89e8e99701b8e01f9', 'CC6.1', 'CC6.2', 'renumbered'),
  // "Logical and physical access is modified or removed when no longer required."
  remap('frk_rq_681ebeb66c09c92d0a3aa9a4', 'CC6.2', 'CC6.3', 'renumbered'),
  // "Unique identifiers are assigned" - user identification, part of CC6.1.
  remap('frk_rq_681ebec24cb46deef1c353ad', 'CC6.3', 'CC6.1', 'retired'),
  // "Authentication mechanisms enforce strong credentials and MFA."
  remap('frk_rq_681ebecd241790316926f987', 'CC6.4', 'CC6.1', 'renumbered'),
  // "Network and session controls restrict unauthorized connections."
  remap('frk_rq_681ebedccee9ea5fa8c02a65', 'CC6.5', 'CC6.6', 'renumbered'),
  // "Physical access to facilities and equipment is limited and monitored."
  remap('frk_rq_681ebeef4c1a070eee80d1c2', 'CC6.6', 'CC6.4', 'renumbered'),
  // "The system is protected against security threats (malware, intrusion, etc.)."
  remap('frk_rq_681ebefe089b8d0483e0759b', 'CC6.7', 'CC6.8', 'renumbered'),
  // "Privileged access is restricted and logged" - least privilege.
  remap('frk_rq_681ebf0e253b7574744e1e31', 'CC6.8', 'CC6.3', 'retired'),
  // "Logical assets removed from controlled facilities remain protected."
  remap('frk_rq_681ebf2048100b3f122547ad', 'CC6.9', 'CC6.7', 'renumbered'),
  // "The system is monitored to detect security events and anomalies."
  remap('frk_rq_681ebf4568696287ad0b6f90', 'CC7.1', 'CC7.2', 'renumbered'),
  // "Vulnerabilities are identified, evaluated, and remediated."
  remap('frk_rq_681ebf578f2bc13a797afac9', 'CC7.2', 'CC7.1', 'renumbered'),
  // "A documented incident-response process exists and is followed."
  remap('frk_rq_681ebf6c0027c27141a8a960', 'CC7.3', 'CC7.4', 'renumbered'),
  // "The entity recovers from security incidents and limits their impact."
  remap('frk_rq_681ebf76b9fc70d3b1c208cf', 'CC7.4', 'CC7.5', 'renumbered'),
  remap('frk_rq_681ebf82fb04727c9ac5b60f', 'CC8.1', 'CC8.1', 'kept'),
  // "Emergency changes are controlled" - an emergency-change point of focus of CC8.1.
  remap('frk_rq_681ebf8c217dab3507c2184d', 'CC8.2', 'CC8.1', 'retired'),
  remap('frk_rq_681ebf963f7055627c5e9d06', 'CC9.1', 'CC9.1', 'kept'),
  remap('frk_rq_681ebfa0fbd5040239459dea', 'CC9.2', 'CC9.2', 'kept'),
  remap('frk_rq_681ec0361397c7584c25cfd8', 'A1.1', 'A1.1', 'kept'),
  remap('frk_rq_681ec056ca6c6a446a9592b5', 'A1.2', 'A1.2', 'kept'),
  remap('frk_rq_681ec06748e853260b8b3c7e', 'A1.3', 'A1.3', 'kept'),
  // "Monitors system availability ... and alerts personnel" - capacity monitoring.
  remap('frk_rq_681edd9def88a866a327ad94', 'A1.4', 'A1.1', 'retired'),
  remap('frk_rq_681ec07bfd2183e3ae0c67ed', 'C1.1', 'C1.1', 'kept'),
  remap('frk_rq_681ec08948b2d4f23b730dd4', 'C1.2', 'C1.2', 'kept'),
  // "Protects confidential information during transmission."
  remap('frk_rq_681edde91036dc41934ae86c', 'C1.3', 'CC6.7', 'retired'),
  // "Securely destroys or anonymizes confidential information."
  remap('frk_rq_681eddfa042be268ab6691d0', 'C1.4', 'C1.2', 'retired'),
  remap('frk_rq_681ec1a899a2a887571df4aa', 'PI1.1', 'PI1.1', 'kept'),
  remap('frk_rq_681ec1b6069818f03f2d825b', 'PI1.2', 'PI1.2', 'kept'),
  remap('frk_rq_681ec1c23827a73da573301b', 'PI1.3', 'PI1.3', 'kept'),
  remap('frk_rq_681ec1cef77f1e699b977397', 'PI1.4', 'PI1.4', 'kept'),
  remap('frk_rq_681ec1dd70d211c500bb5c1d', 'PI1.5', 'PI1.5', 'kept'),
  remap('frk_rq_681ec0a6d8253499731bf1a8', 'P1.1', 'P1.1', 'kept'),
  // P1.2-P1.4 (recipients, retention periods, notice updates) are all P1.1 notice content.
  remap('frk_rq_681ede37505bc1a997f77dc5', 'P1.2', 'P1.1', 'retired'),
  remap('frk_rq_681ede4a7c9ab83c5c681709', 'P1.3', 'P1.1', 'retired'),
  remap('frk_rq_681ede6ae05fcf29f2ad23de', 'P1.4', 'P1.1', 'retired'),
  remap('frk_rq_681ec0b71471801116d2fe85', 'P2.1', 'P2.1', 'kept'),
  remap('frk_rq_681ec0c7a3cba055161dd313', 'P3.1', 'P3.1', 'kept'),
  remap('frk_rq_681ec0d5d3291d5c24740643', 'P4.1', 'P4.1', 'kept'),
  // "Personal information is used only for stated purposes."
  remap('frk_rq_681ede9499fe462921d84ff7', 'P4.2', 'P4.1', 'retired'),
  // "Enforces retention limits for personal information."
  remap('frk_rq_681edea7ac4bb2b63e0533df', 'P4.3', 'P4.2', 'renumbered'),
  // "Securely destroys or anonymizes personal information at end of retention."
  remap('frk_rq_681edeb6d0f49c836fe98f78', 'P4.4', 'P4.3', 'renumbered'),
  remap('frk_rq_681ec0e33dfb98fa4c9d816d', 'P5.1', 'P5.1', 'kept'),
  remap('frk_rq_681ec0f5b2b495e83e400f70', 'P5.2', 'P5.2', 'kept'),
  // "Verifies requester identity" - P5.1 covers identified and authenticated data subjects.
  remap('frk_rq_681eded32a14e3e374ffc7a3', 'P5.3', 'P5.1', 'retired'),
  // "Fulfils data-subject requests within required timeframes."
  remap('frk_rq_681edee1a542a42b4f113025', 'P5.4', 'P5.1', 'retired'),
  remap('frk_rq_681ec106a6c4bfb432e9ad25', 'P6.1', 'P6.1', 'kept'),
  // "Third parties receiving personal information have the capacity to protect it."
  remap('frk_rq_681ec11759ccbcf28d305937', 'P6.2', 'P6.4', 'renumbered'),
  // "Monitors compliance ... by third parties" - P6.4 assesses those parties' compliance.
  remap('frk_rq_681ec131e53b6d2cd2c503f8', 'P6.3', 'P6.4', 'retired'),
  // "Procedures for addressing privacy complaints."
  remap('frk_rq_681ec1433e7cc7e0d5ff9f1f', 'P6.4', 'P8.1', 'renumbered'),
  // "Documents and updates privacy responsibilities and procedures."
  remap('frk_rq_681ec1501d0047d7955100bf', 'P6.5', 'CC5.3', 'retired'),
  // "Trains personnel regarding privacy obligations and responsibilities."
  remap('frk_rq_681ec15ddc61ddeeaa5cf021', 'P6.6', 'CC2.2', 'retired'),
  // "Reviews privacy objectives and related risks regularly."
  remap('frk_rq_681ec177384d64f18500e0b7', 'P6.7', 'CC3.2', 'retired'),
  // "Notifies affected parties and regulators of privacy breaches."
  remap('frk_rq_681edf0e7c9b0e5c4330ffc4', 'P6.8', 'P6.6', 'renumbered'),
  // "Protects personal information with security safeguards" - security is covered by CC6.
  remap('frk_rq_681ec186220d775ae5ff4f87', 'P7.1', 'CC6.1', 'retired'),
  // "Maintains the quality, accuracy, and completeness of personal information."
  remap('frk_rq_681ec196c3b11c6c9e97649a', 'P8.1', 'P7.1', 'renumbered'),
];
