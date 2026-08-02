export type RobotDefinition = {
  id: number;
  name: string;
  summary: string;
  capabilities: string[];
  limitations: string[];
};

export const ROBOT_CATALOG: RobotDefinition[] = [
  { id: 1, name: "LIL COMPANION", summary: "Basic indoor errand humanoid for carrying light household or office objects to a specified location.", capabilities: ["light object delivery", "indoor errands", "small item carrying"], limitations: ["not for heavy loads", "not for stairs", "not for people or animals"] },
  { id: 2, name: "MINI BUDDY", summary: "Small companion robot for safe play, gestures, and short-distance interaction with children and pets.", capabilities: ["play", "pet-friendly interaction", "small item carrying", "short companion walks"], limitations: ["not for heavy loads", "not for unsupervised childcare", "not for large dogs"] },
  { id: 3, name: "ADVANCED SERVICE MODEL", summary: "Indoor service robot for serving, small logistics, and repeated support in hotels, restaurants, events, and public venues.", capabilities: ["serving", "small logistics", "tray delivery", "indoor obstacle-aware travel"], limitations: ["not for stairs", "not for delicate hand work", "not for crowd control"] },
  { id: 4, name: "Mr. HEAVY", summary: "High-output hybrid transport robot for moving heavy objects over longer indoor routes, including moving and event setup.", capabilities: ["heavy object transport", "boxes and equipment", "cart pushing", "room-to-room movement"], limitations: ["not for people", "not for extreme loads", "not for narrow steep stairs"] },
  { id: 5, name: "Mr. POWER", summary: "Heavy-duty robot optimized for holding, supporting, aligning, and stabilizing heavy objects during work.", capabilities: ["load support", "stabilization", "alignment", "temporary holding during installation"], limitations: ["not for lifting people", "not for indefinite structural support", "not for delicate work"] },
  { id: 6, name: "PACEMAKER", summary: "High-speed running companion that maintains pace and carries water, towels, snacks, and exercise gear.", capabilities: ["running pace", "exercise companionship", "sports item carrying", "route-side reminders"], limitations: ["not for roads", "not for rough trails", "not for lifting or supporting people"] },
  { id: 7, name: "PUPPY", summary: "Low-profile quadruped companion for following, play, low-space observation, patrol, and small-load carrying.", capabilities: ["following", "pet-like play", "low-space inspection", "small load carrying"], limitations: ["cannot pick up objects with hands", "not for large-dog control", "not for physical restraint"] },
  { id: 8, name: "KENTAUROS PAPA", summary: "Large quadruped heavy-work robot with rear locking cable for towing carts, equipment, and large frames.", capabilities: ["towing", "large equipment movement", "heavy positioning", "push and pull work"], limitations: ["not for carrying people", "not for passenger riding", "not for extreme hazardous loads"] },
  { id: 9, name: "KENTAUROS MINI", summary: "Small quadruped errand robot for indoor-outdoor household routes such as yards, porches, gardens, and mild slopes.", capabilities: ["indoor-outdoor errands", "light carrying", "yard and porch movement", "short outdoor companionship"], limitations: ["not for towing large equipment", "not for childcare or animal control", "not for severe terrain"] },
  { id: 10, name: "BUSY CENTIPEDE", summary: "Multi-arm venue operations robot using displays and a trailer for information, parallel distribution, and small logistics.", capabilities: ["information display", "multi-person distribution", "small logistics", "event operations"], limitations: ["not for heavy loads", "not for fine assembly", "not for stairs"] },
  { id: 11, name: "THE MULTITASKER", summary: "Multi-arm service robot with an independent drone for parallel cooking preparation, sorting, organizing, and tool delivery.", capabilities: ["cooking preparation", "organizing", "sorting", "parallel daily tasks", "drone-assisted visibility"], limitations: ["not for heavy transport", "not for high-load lifting", "not for unsafe outdoor flight"] },
  { id: 12, name: "SHERPA", summary: "Snow-capable transport robot for carrying equipment and supplies while following people in winter outdoor environments.", capabilities: ["snow travel", "winter supply transport", "ski-area support", "snowfield following"], limitations: ["not for ordinary indoor service", "not for deep water", "not for precision assembly"] },
  { id: 13, name: "LOADER HEAVY", summary: "Low wide loader robot with the series' strongest direct lift for moving heavy objects from the floor to loading platforms.", capabilities: ["floor-to-platform lifting", "large boxes", "equipment cases", "loading and unloading"], limitations: ["not for people", "not for stairs", "not for delicate objects"] },
  { id: 14, name: "AQUARIUS", summary: "Wet-environment robot with water-resistant structure and spray hoses for cleaning, drainage support, and water-side inspection.", capabilities: ["water cleaning", "washing", "drainage support", "wet-area inspection"], limitations: ["not for deep underwater diving", "not for dry-only errands", "not for high precision assembly"] },
  { id: 15, name: "ASYMMETRICAL TASK FOCUS MODEL", summary: "Specialist robot with very long arms and asymmetric tools for elevated installation, cable rigging, camera setup, and blind-spot inspection.", capabilities: ["high-place work", "ceiling installation", "cable rigging", "camera setup", "elevated inspection"], limitations: ["not for ordinary errands", "not for unstable terrain", "not for unsupervised human lifting"] },
  { id: 16, name: "QUAD-ARMED WORK FORCE", summary: "Four-arm specialist combining high-output tool arms and precision hands for clamping, machining, fastening, and assembly.", capabilities: ["tool use", "precision assembly", "drilling", "fastening", "repair and maintenance"], limitations: ["not for general transport", "not for stairs", "not for people"] },
  { id: 17, name: "LIL CHUBBY", summary: "Mobile storage and supply robot with a large body for carrying many bulky but light items and handing them out.", capabilities: ["many-item storage", "bulk light-item carrying", "mobile supply", "following with supplies"], limitations: ["not for heavy objects", "not for precision manipulation", "not for stairs"] },
  { id: 18, name: "Mr. SENSORPACKET", summary: "Spatial perception robot using lidar and sensors to scan facilities, map movement, record changes, and compare states.", capabilities: ["scanning", "3D mapping", "spatial recording", "flow analysis", "digital twin updates"], limitations: ["not for object transport", "not for cleaning", "not for lifting"] },
];

export const ROUTING_POLICY = `
Preserve this priority order exactly:
STEP 0 hidden-code contains matching wins over every other rule.
STEP 1 hard environment rules: snow/ski/snowfield/winter outdoor/snow road -> 12; water cleaning/washing/pool/flood/wet/drainage/water spray -> 14; scan/3D map/spatial mapping/route analysis/digital twin/spatial recording -> 18. If multiple STEP 1 groups appear, 18 wins over 14 and 12.
STEP 2 group A household errands: many items at once -> 17; outdoor route such as yard/garden/terrace/porch/camping/picnic -> 9; otherwise -> 1.
STEP 2 group B companion: movement-led following/walk/low space/patrol -> 7; play, toy, interaction, friend-like -> 2; unclear -> 2. Pets prefer 2, children prefer 7.
STEP 2 group C commercial service: information/display/queue number/multiple directions/multiple people -> 10; simple serving/carrying/delivery -> 3; unclear distribution -> 10.
STEP 2 group D heavy movement: towing/cart/wire -> 8; floor-to-platform/loading -> 13; fixed support/stabilization -> 5; ordinary moving/carrying -> 4; moving plus support -> 4.
STEP 2 group E elevated precision: high/ceiling/cable/camera/rigging -> 15, including high plus tool; otherwise tool/fastening/drill/assembly/repair -> 16; otherwise -> 5.
STEP 2 group F parallel work: tool/precision work -> 16; cooking/preparation/organizing/sorting/parallel daily tasks -> 11; unclear -> 11.
STEP 2 group G outdoor companion: snow -> 12; running/pace/jogging -> 6; ordinary camping/picnic/hiking entrance/park/yard -> 9; unclear -> 9.
STEP 3 if no group applies, use the supplied fallback candidate 1 or 2.
Never invent a robot outside IDs 1-18. The title and tasks must be in English and grounded in the selected robot's capabilities. Do not claim capabilities listed as limitations.
`;
