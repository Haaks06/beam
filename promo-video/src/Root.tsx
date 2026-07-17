import "./index.css";
import { Composition } from "remotion";
import { BeamPromo, BEAM_PROMO_DURATION } from "./BeamPromo";
import { Scene1Pairing, SCENE1_DURATION } from "./scenes/Scene1Pairing";
import { Scene2Home, SCENE2_DURATION } from "./scenes/Scene2Home";
import { Scene3Transfer, SCENE3_DURATION } from "./scenes/Scene3Transfer";
import { Scene4SendType, SCENE4_DURATION } from "./scenes/Scene4SendType";
import { Scene5Desktop, SCENE5_DURATION } from "./scenes/Scene5Desktop";
import { Scene6Everywhere, SCENE6_DURATION } from "./scenes/Scene6Everywhere";
import { Scene7BrandCombo, SCENE7_DURATION } from "./scenes/Scene7BrandCombo";
import { Scene8CTA, SCENE8_DURATION } from "./scenes/Scene8CTA";

const SCENE_PROPS = { fps: 30, width: 1080, height: 700, defaultProps: {} };

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="BeamPromo"
        component={BeamPromo}
        durationInFrames={BEAM_PROMO_DURATION}
        {...SCENE_PROPS}
      />
      <Composition
        id="Scene1Test"
        component={Scene1Pairing}
        durationInFrames={SCENE1_DURATION}
        {...SCENE_PROPS}
      />
      <Composition
        id="Scene2Test"
        component={Scene2Home}
        durationInFrames={SCENE2_DURATION}
        {...SCENE_PROPS}
      />
      <Composition
        id="Scene3Test"
        component={Scene3Transfer}
        durationInFrames={SCENE3_DURATION}
        {...SCENE_PROPS}
      />
      <Composition
        id="Scene4Test"
        component={Scene4SendType}
        durationInFrames={SCENE4_DURATION}
        {...SCENE_PROPS}
      />
      <Composition
        id="Scene5Test"
        component={Scene5Desktop}
        durationInFrames={SCENE5_DURATION}
        {...SCENE_PROPS}
      />
      <Composition
        id="Scene6Test"
        component={Scene6Everywhere}
        durationInFrames={SCENE6_DURATION}
        {...SCENE_PROPS}
      />
      <Composition
        id="Scene7Test"
        component={Scene7BrandCombo}
        durationInFrames={SCENE7_DURATION}
        {...SCENE_PROPS}
      />
      <Composition
        id="Scene8Test"
        component={Scene8CTA}
        durationInFrames={SCENE8_DURATION}
        {...SCENE_PROPS}
      />
    </>
  );
};
