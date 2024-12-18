import {
  PanelExtensionContext,
  Topic,
  SettingsTreeAction,
  MessageEvent as FoxgloveMessageEvent,
} from "@foxglove/extension";
import { Quaternion } from "@foxglove/schemas";
import {
  ReactElement,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import produce from "immer";
import { set } from "lodash";

type PanelState = {
  data: {
    topic?: string;
  };
};

const config = {
  grid: {
    show: { xy: true },
    size: 8,
    divisions: 10,
    colors: { center: 0xffffff, grid: 0x666666 },
    opacity: 0.5,
  },
  axis: {
    show: true,
    length: 5,
    colors: { x: 0xff0000, y: 0x00ff00, z: 0x0000ff },
    arrowSize: { radius: 0.1, height: 0.4 },
  },
  topicArrow: {
    length: 4,
    color: 0xffff00, // Yellow
    arrowSize: { radius: 0.15, height: 0.6 }, // Larger than the axis arrows
  },
  camera: {
    fov: 75,
    distance: { min: 6, max: 12, initial: 10 },
  },
  scene: {
    backgroundColor: 0x333333,
  },
};

function extractQuaternion(message: unknown): Quaternion | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const msg = message as any;

  // Direct quaternion
  if (msg.x !== undefined && msg.y !== undefined && msg.z !== undefined && msg.w !== undefined) {
    return msg;
  }

  // IMU message
  if (msg.orientation) {
    return msg.orientation;
  }

  // Pose message
  if (msg.pose?.orientation) {
    return msg.pose.orientation;
  }

  // Pose with covariance (like in Odometry)
  if (msg.pose?.pose?.orientation) {
    return msg.pose.pose.orientation;
  }

  return undefined;
}

function OrientationPanel3D({ context }: { context: PanelExtensionContext }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const axisGroupRef = useRef<THREE.Group | null>(null);
  const topicArrowRef = useRef<THREE.ArrowHelper | null>(null);
  const [topics, setTopics] = useState<readonly Topic[] | undefined>();
  const [message, setMessage] = useState<FoxgloveMessageEvent<unknown> | undefined>();
  const isDraggingRef = useRef(false);
  const previousMouseXRef = useRef(0);

  const [state, setState] = useState<PanelState>(() => {
    const partialState = context.initialState as Partial<PanelState>;
    return {
      data: {
        topic: partialState.data?.topic,
      },
    };
  });

  // Handle window resize
  const handleResize = useCallback(() => {
    if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    rendererRef.current.setSize(width, height);
    cameraRef.current.aspect = width / height;
    cameraRef.current.updateProjectionMatrix();
  }, []);

  // Setup resize observer
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [handleResize]);

  const orientationTopics = useMemo(
    () =>
      (topics ?? []).filter(
        (topic) =>
          topic.schemaName === "sensor_msgs/Imu" ||
          topic.schemaName === "geometry_msgs/Quaternion" ||
          topic.schemaName === "geometry_msgs/Pose" ||
          topic.schemaName === "geometry_msgs/PoseStamped" ||
          topic.schemaName === "geometry_msgs/PoseWithCovariance" ||
          topic.schemaName === "geometry_msgs/PoseWithCovarianceStamped" ||
          topic.schemaName === "nav_msgs/Odometry",
      ),
    [topics],
  );

  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      if (action.action === "update") {
        const { path, value } = action.payload;
        setState(produce((draft) => set(draft, path, value)));

        if (path[1] === "topic") {
          context.subscribe([{ topic: value as string }]);
        }
      }
    },
    [context],
  );

  useEffect(() => {
    context.saveState(state);
    const topicOptions = (orientationTopics ?? []).map((topic) => ({
      value: topic.name,
      label: topic.name,
    }));

    context.updatePanelSettingsEditor({
      actionHandler,
      nodes: {
        data: {
          label: "Data",
          icon: "Cube",
          fields: {
            topic: {
              label: "Topic",
              input: "select",
              options: topicOptions,
              value: state.data.topic,
            },
          },
        },
      },
    });
  }, [context, actionHandler, state, orientationTopics]);

  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(config.scene.backgroundColor);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(config.camera.fov, 1, 0.1, 1000);
    const distance = config.camera.distance.initial;
    camera.position.set(distance, distance, distance);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    camera.aspect = renderer.domElement.width / renderer.domElement.height;
    camera.updateProjectionMatrix();

    if (config.grid.show.xy) {
      const grid = new THREE.GridHelper(
        config.grid.size,
        config.grid.divisions,
        config.grid.colors.center,
        config.grid.colors.grid,
      );
      grid.material.transparent = true;
      grid.material.opacity = config.grid.opacity;
      grid.material.depthWrite = false;
      grid.rotateX(Math.PI * 0.5);
      scene.add(grid);
    }

    const axisGroup = new THREE.Group();

    const axes = [
      { dir: new THREE.Vector3(0, 0, 1), color: config.axis.colors.z },
      { dir: new THREE.Vector3(0, 1, 0), color: config.axis.colors.x },
      { dir: new THREE.Vector3(-1, 0, 0), color: config.axis.colors.y },
    ];

    axes.forEach(({ dir, color }) => {
      const arrowHelper = new THREE.ArrowHelper(
        dir,
        new THREE.Vector3(0, 0, 0),
        config.axis.length,
        color,
        config.axis.arrowSize.height,
        config.axis.arrowSize.radius,
      );
      axisGroup.add(arrowHelper);
    });

    scene.add(axisGroup);
    axisGroupRef.current = axisGroup;

    // Add the topic arrow
    const direction = new THREE.Vector3(1, 0, 0);
    const origin = new THREE.Vector3(0, 0, 0);
    const length = config.topicArrow.length;
    const hex = config.topicArrow.color;

    // Create custom arrow with thicker line
    const topicArrow = new THREE.ArrowHelper(
      direction,
      origin,
      length,
      hex,
      config.topicArrow.arrowSize.height,
      config.topicArrow.arrowSize.radius,
    );

    // Set line thickness
    if (topicArrow.line) {
      (topicArrow.line as THREE.Line).material = new THREE.LineBasicMaterial({
        color: hex,
        linewidth: 4,
        opacity: 0.6
      });
    }

    scene.add(topicArrow);
    topicArrowRef.current = topicArrow;

    const animate = () => {
      requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };

    const handleMouseDown = (event: MouseEvent) => {
      isDraggingRef.current = true;
      previousMouseXRef.current = event.clientX;
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (!isDraggingRef.current || !cameraRef.current) return;

      const deltaX = event.clientX - previousMouseXRef.current;
      const rotationAngle = deltaX * 0.01; // Adjust this multiplier to control rotation speed

      // Rotate the camera around the Z axis
      const radius = Math.sqrt(
        cameraRef.current.position.x * cameraRef.current.position.x +
          cameraRef.current.position.y * cameraRef.current.position.y,
      );

      const currentAngle = Math.atan2(cameraRef.current.position.y, cameraRef.current.position.x);

      const newAngle = currentAngle - rotationAngle;

      cameraRef.current.position.x = radius * Math.cos(newAngle);
      cameraRef.current.position.y = radius * Math.sin(newAngle);
      cameraRef.current.lookAt(0, 0, 0);

      previousMouseXRef.current = event.clientX;
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
    };

    renderer.domElement.addEventListener("mousedown", handleMouseDown);
    renderer.domElement.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    animate();

    return () => {
      renderer.dispose();
      if (containerRef.current?.contains(renderer.domElement)) {
        containerRef.current.removeChild(renderer.domElement);
      }
      renderer.domElement.removeEventListener("mousedown", handleMouseDown);
      renderer.domElement.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!message || !axisGroupRef.current || !topicArrowRef.current) return;

    const quaternion = extractQuaternion(message.message);

    if (quaternion) {
      const threeQuaternion = new THREE.Quaternion(
        quaternion.x,
        quaternion.y,
        quaternion.z,
        quaternion.w,
      );
      // Only rotate the topic arrow, leaving the axis arrows fixed
      topicArrowRef.current.setRotationFromQuaternion(threeQuaternion);
    }
  }, [message]);

  useLayoutEffect(() => {
    context.onRender = (
      renderState: {
        currentFrame?: readonly FoxgloveMessageEvent<unknown>[];
        topics?: readonly Topic[];
      },
      done,
    ) => {
      setRenderDone(() => done);
      setTopics(renderState.topics);

      if (renderState.currentFrame?.length) {
        setMessage(renderState.currentFrame[renderState.currentFrame.length - 1]);
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
  }, [context]);

  useEffect(() => {
    if (state.data.topic) {
      context.subscribe([{ topic: state.data.topic }]);
    }
  }, [context, state.data.topic]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

export function initOrientationPanel3D(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<OrientationPanel3D context={context} />);
  return () => {
    root.unmount();
  };
}
