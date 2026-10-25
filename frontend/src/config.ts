// All tunable constants. Units: meters, seconds unless noted.

export type LightPreset = 'day' | 'overcast' | 'dusk' | 'night';
export type ScenarioId = 'regular' | 'rainy' | 'rush' | 'dead';

export const CONFIG = {
  street: {
    length: 90,          // block length along X
    sidewalkNearZ: [-8, -2] as [number, number], // storefront sidewalk (facade at -8, curb at -2)
    roadZ: [-2, 12] as [number, number],
    sidewalkFarZ: [12, 18] as [number, number],
    lanes: [-7.0, -5.6, -4.2, -2.9], // walking lanes (z) on the near sidewalk
    farLanes: [13.0, 14.4, 15.8, 17.2],
  },
  storefront: {
    centerX: 0,
    width: 9,
    facadeZ: -8,
    doorX: 3.0,
    focusHeight: 1.6,
    zoneHalfWidth: 9,   // attention zone extends ±this in X from centerX
    depth: 10,          // interior depth behind the facade
    counter: [0.5, -15.3] as [number, number],          // x,z of the order counter stop point
    browsePoints: [[-3.2, -10.5], [-3.2, -13.5], [2.6, -11.0], [2.6, -14.0], [0.2, -12.5]] as [number, number][],
  },
  pedestrian: {
    speedMin: 1.1,
    speedMax: 1.6,
    radius: 0.35,
    headHeight: 1.65,
    separationDist: 0.9,
    headTurnRate: 4.0,  // rad/s
    spawnX: 46,
    despawnX: 47,
  },
  interior: {
    browseDur: [4, 12] as [number, number],
    counterDur: [3, 8] as [number, number],
    secondBrowseChance: 0.5,
    buyBase: 0.3,          // + 0.4*interest + campaign lift
    walkSpeed: 0.9,
  },
  scenarios: {
    // buyMul: purchase propensity once inside. Dinner rush is deliberately low: crowds browse and
    // peek in but few buy, which is the "traffic up, sales flat" signal the manager agent looks for.
    regular: { label: 'Regular day', spawnPerMin: 40, interestMul: 1.0, speedMul: 1.0, buyMul: 1.0, rain: false, light: 'day' },
    rainy:   { label: 'Rainy day',   spawnPerMin: 14, interestMul: 0.6, speedMul: 1.2, buyMul: 0.8, rain: true,  light: 'overcast' },
    rush:    { label: 'Dinner rush', spawnPerMin: 110, interestMul: 1.3, speedMul: 0.95, buyMul: 0.3, rain: false, light: 'dusk' },
    dead:    { label: 'Dead hours',  spawnPerMin: 6,  interestMul: 0.9, speedMul: 1.0, buyMul: 1.0, rain: false, light: 'night' },
  } as Record<string, { label: string; spawnPerMin: number; interestMul: number; speedMul: number; buyMul: number; rain: boolean; light: LightPreset }>,
  campaign: {
    posterLift: 0.12,      // attractiveness bonus for a window poster
    bannerLift: 0.10,      // attractiveness bonus for a banner above the sign
    conversionLift: 0.2,   // added to buy / enter odds while a campaign is live
  },
  behavior: {
    glanceRatePerSec: 0.5,      // base probability/s to glance while in zone (scaled by interest*attractiveness)
    stopRatePerSec: 0.06,
    enterRatePerSec: 0.015,
    glanceDur: [0.6, 2.0] as [number, number],
    stopDur: [2.0, 6.0] as [number, number],
    minInterest: 0.05,
  },
  camera: {
    position: [0, 3.0, -7.6] as [number, number, number],
    fovDeg: 95,
    range: 15,
    gazeConeDeg: 25,
    minGazeMs: 300,
    hysteresisMs: 250,
  },
  metrics: {
    windowSec: 60,
    heatBuckets: 16,
  },
  alerts: {
    minPassersby: 15,
    lowLookRate: 0.2,
    browseNoBuy: 4,          // visitors who left without buying while purchases == 0
    highDwellLooks: 4,       // looks over longDwellSec with zero entries
    longDwellSec: 2.5,
    surgePerMin: 60,
    cooldownSec: 30,
  },
  sim: {
    spawnPerMin: 40,
    fixedDt: 1 / 60,
    maxSubSteps: 240,  // sim is cheap; let it catch up when rendering is slow
  },
};

export type Config = typeof CONFIG;
