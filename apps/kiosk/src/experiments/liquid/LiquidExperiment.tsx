import { LiquidEther } from "./LiquidEther";
import { liquidColors } from "./assetColors";
import "./liquidEther.css";

/**
 * Standalone preview (?exp=liquid) of the LiquidEther cursor-fluid with the brand palette. Here it
 * uses the upstream real-mouse listeners + autoDemo (no pointerSource), so it can be driven by a
 * desktop mouse for tuning. The home hero wires it to the phone-driven cursor instead.
 */
export function LiquidExperiment() {
  return (
    <div className="liquid-exp">
      <LiquidEther
        colors={liquidColors}
        mouseForce={19}
        cursorSize={55}
        isViscous={false}
        resolution={0.5}
        autoDemo
        autoSpeed={0.5}
        autoIntensity={2.2}
        takeoverDuration={0.25}
        autoResumeDelay={3000}
        autoRampDuration={0.6}
      />
    </div>
  );
}
