/**
 * Data for the person-detail experiment (?exp=person) — currently just Weihang Li, whose
 * TypeShuffle "terminal" profile is being locked here, decoupled from the real roster.
 *
 * The roster itself lives in content/people.json + the real People section (CLAUDE.md rule 3).
 * This module only holds the richer profile fields the detail page shows; when the detail is
 * promoted, these move onto the Person schema (which already has optional slots for them).
 */

export interface PersonProfile {
  website?: string;
  researchInterests: string[];
  /** A short note shown under the interests (e.g. a collaboration invite). */
  researchNote?: string;
  /** Free-text recent-work line (paper shorthand). */
  recentWork?: string;
  professionalServices: string[];
  curriculumVitae: string;
}

export interface PersonRow {
  id: string;
  last: string;
  first: string;
  /** Academic title / degree, e.g. "M.Sc.". */
  title: string;
  email: string;
  room?: string;
  profile?: PersonProfile;
}

/** Unified placeholder-avatar style (DiceBear). Swap this one constant to try another look. */
export const AVATAR_STYLE = "personas";

/** DiceBear SVG URL for a person's placeholder avatar (transparent bg → our frame shows). */
export const avatarUrl = (person: PersonRow): string =>
  `https://api.dicebear.com/9.x/${AVATAR_STYLE}/svg?seed=${encodeURIComponent(
    `${person.first} ${person.last}`,
  )}&backgroundColor=transparent`;

export const weihang: PersonRow = {
  id: "weihang-li",
  last: "Li",
  first: "Weihang",
  title: "M.Sc.",
  email: "weihang.li@tum.de",
  room: "STC",
  profile: {
    website: "colin-de.github.io",
    researchInterests: [
      "World Model",
      "Embodied AI / Robotics",
      "3D / 4D Vision (Object / Scene-level Pose, Depth)",
    ],
    researchNote: "Feel free to contact me about collaborating on the above topics.",
    recentWork:
      "OPT-Pose (CVPR'26), TRICKY-Housecat (ICCV'25), GCE-Pose (CVPR'25), DynSUP (TIP'26), AFT-CT (in submission to TRO), SCRREAM (NeurIPS'24), Texture2LoD (CVPR'25), Kb-PbD (IROS'24)",
    professionalServices: [
      "Reviewer for CVPR, ICCV, NeurIPS, ECCV, ICRA, IROS, BMVC, RAL, TRO, ACL",
      "Organizer — 1st ICCV Workshop & Challenge on Category-Level Object Pose Estimation in the Wild (ICCV 2025)",
      "Organizer — HouseCat-Tricky Challenge, Workshop on Transparent & Reflective Objects in the Wild (ICCV 2025)",
    ],
    curriculumVitae:
      "PhD student with TUM & MCML, supervised by Prof. Benjamin Busam and Prof. Nassir Navab. During his Master's at TUM Robotics, Cognition, Intelligence, he conducted research at CAMP, fortiss, and Photogrammetry & Remote Sensing with Prof. Olaf Wysocki, at HKUST-GZ with Prof. Haoang Li, and at CVG with Prof. Daniel Cremers.",
  },
};
