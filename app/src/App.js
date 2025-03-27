import React, { useState, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import JSZip from 'jszip';

function App() {
  // ---------------------------
  // Section 1: Background Removal & Run Model (port 8000)
  // ---------------------------
  const [originalFile, setOriginalFile] = useState(null);
  // New state to store the URL for the original file preview
  const [originalImageUrl, setOriginalImageUrl] = useState(null);
  
  const [previewImage, setPreviewImage] = useState(null);
  const [processedFile, setProcessedFile] = useState(null);
  const [modelData, setModelData] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');

  const [foregroundRatio, setForegroundRatio] = useState(0.85);
  const [remeshOption, setRemeshOption] = useState('none');
  const [vertexCount, setVertexCount] = useState(-1);
  const [textureSize, setTextureSize] = useState(1024);
  const [ormImageUrl, setOrmImageUrl] = useState("");


  const [sampleFolder, setSampleFolder] = useState("");

  const canvasContainerRef = useRef(null);
  const rendererRef = useRef(null);

  // Helper: Convert a data URL to a Blob.
  const dataURLtoBlob = (dataurl) => {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    const n = bstr.length;
    const u8arr = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      u8arr[i] = bstr.charCodeAt(i);
    }
    return new Blob([u8arr], { type: mime });
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setOriginalFile(file);
    // Create and store the URL for the original file preview
    setOriginalImageUrl(URL.createObjectURL(file));
    
    setErrorMessage('');
    const formData = new FormData();
    formData.append('image', file);
    formData.append('foreground_ratio', foregroundRatio);

    try {
      const response = await fetch('http://localhost:8000/remove_background', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) throw new Error('Failed to remove background');
      const data = await response.json();
      const base64Data = `data:image/png;base64,${data.foreground_image}`;
      setPreviewImage(base64Data);
      const blob = dataURLtoBlob(base64Data);
      setProcessedFile(blob);
    } catch (err) {
      console.error(err);
      setErrorMessage(err.message);
    }
  };

  const handleRunModel = async () => {
    if (!processedFile) {
      alert('No processed image available.');
      return;
    }
    setErrorMessage('');
    const formData = new FormData();
    formData.append('image', processedFile, 'processed.png');
    formData.append('foreground_ratio', foregroundRatio);
    formData.append('remesh_option', remeshOption);
    formData.append('vertex_count', vertexCount);
    formData.append('texture_size', textureSize);

    try {
      const response = await fetch('http://localhost:8000/run_model', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to run model: ${errorText}`);
      }
      // IMPORTANT: Read the sample folder from the response header.
      const sf = response.headers.get("Output-Folder");
      console.log("Sample Folder from header:", sf);
      setSampleFolder(sf || "");

      // Process the zip file response.
      const zipBlob = await response.blob();
      const zip = await JSZip.loadAsync(zipBlob);

      let objEntry, mtlEntry, albedoEntry;
      zip.forEach((relativePath, zipEntry) => {
        if (relativePath.endsWith('.obj')) {
          objEntry = zipEntry;
        } else if (relativePath.endsWith('.mtl')) {
          mtlEntry = zipEntry;
        } else if (relativePath.endsWith('.png')) {
          albedoEntry = zipEntry;
        }
      });
      if (!objEntry || !mtlEntry || !albedoEntry) {
        throw new Error('Missing required files in zip');
      }
      const objBlob = await objEntry.async('blob');
      const mtlBlob = await mtlEntry.async('blob');
      const albedoBlob = await albedoEntry.async('blob');
      const objUrl = URL.createObjectURL(objBlob);
      const mtlUrl = URL.createObjectURL(mtlBlob);
      const albedoUrl = URL.createObjectURL(albedoBlob);
      setModelData({ objUrl, mtlUrl, albedoUrl });
    } catch (err) {
      console.error(err);
      setErrorMessage(err.message);
      alert('Error running model.');
    }
  };

  // Initialize Three.js scene for Section 1.
  useEffect(() => {
    if (!modelData) return;
    if (rendererRef.current) {
      rendererRef.current.dispose();
      if (canvasContainerRef.current.firstChild) {
        canvasContainerRef.current.removeChild(canvasContainerRef.current.firstChild);
      }
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdddddd);
    const width = canvasContainerRef.current.clientWidth;
    const height = canvasContainerRef.current.clientHeight;
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 1, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    rendererRef.current = renderer;
    canvasContainerRef.current.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 7.5);
    scene.add(directionalLight);
    const mtlLoader = new MTLLoader();
    mtlLoader.setResourcePath("");
    
    mtlLoader.load(modelData.mtlUrl, (materials) => {
      materials.preload();
      const objLoader = new OBJLoader();
      objLoader.setMaterials(materials);
      objLoader.load(modelData.objUrl, (object) => {
        // Explicitly load the albedo texture using our blob URL:
        const textureLoader = new THREE.TextureLoader();
        const albedoTexture = textureLoader.load(modelData.albedoUrl);
        object.traverse((child) => {
          if (child.isMesh) {
            // Force the texture to our albedoTexture regardless of the MTL file reference.
            child.material.map = albedoTexture;
            child.material.needsUpdate = true;
          }
        });
        scene.add(object);
      });
    });
    const animate = () => {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    const handleResize = () => {
      const width = canvasContainerRef.current.clientWidth;
      const height = canvasContainerRef.current.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [modelData]);

  // ---------------------------
  // Section 2: White Model Display & Materialisation (port 8080)
  // ---------------------------
  const [displayData, setDisplayData] = useState(null); // { uv_image, mesh_path }
  const [renderViews, setRenderViews] = useState(null); // array of 5 base64 images
  const [segViews, setSegViews] = useState(null); // array of 5 base64 segmentation images

  const secondCanvasRef = useRef(null);
  const secondRendererRef = useRef(null);

  const [category, setCategory] = useState("car");
  const categoryOptions = ["car", "furniture", "building", "instrument", "plant"];

  const handleLoadWhiteModel = async () => {
    if (!sampleFolder) {
      alert("First model must be run to produce output.");
      return;
    }
    try {
      console.log("Sending to /display:", JSON.stringify({ sample_folder: sampleFolder }));
      const response = await fetch("http://localhost:8080/display", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sample_folder: sampleFolder }),
      });
      const data = await response.json();
      if (data.error) {
        alert("Error in display: " + data.error);
      } else {
        setDisplayData(data); // data contains uv_image and mesh_path
      }
    } catch (err) {
      console.error(err);
      alert("Error loading white model.");
    }
  };

  const handleRender = async () => {
    if (!sampleFolder) {
      alert("First model must be run to produce output.");
      return;
    }
    try {
      // Call get_rendering on port 8080.
      let response = await fetch("http://localhost:8080/get_rendering", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zip_file: sampleFolder })
      });
      let data = await response.json();
      if (data.error) throw new Error(data.error);
      setRenderViews([data.view1, data.view2, data.view3, data.view4, data.view5]);
      // Call get_segmentation on port 8080.
      response = await fetch("http://localhost:8080/get_segmentation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zip_file: sampleFolder, category })
      });
      data = await response.json();
      if (data.error) throw new Error(data.error);
      setSegViews([data.seg1, data.seg2, data.seg3, data.seg4, data.seg5]);
    } catch (err) {
      console.error(err);
      alert("Error in rendering or segmentation: " + err.message);
    }
  };  

  const handleMaterialise = async () => {
    if (!sampleFolder || !category) {
      alert("Sample folder and category are required.");
      return;
    }
    try {
      const response = await fetch("http://localhost:8080/render_to_uv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zip_file: sampleFolder, category }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      // Set the ORM image URL returned by the API.
      setOrmImageUrl(data.ORM_image_url);
      // The model will be re-rendered via the useEffect below when ormImageUrl updates.
    } catch (err) {
      console.error(err);
      alert("Error in materialisation: " + err.message);
    }
  };

  const renderMaterialisedModel = () => {
    // Ensure we have the white model (displayData.mesh_path) and the ORM image URL.
    if (!displayData || !displayData.mesh_path || !ormImageUrl) return;
  
    // Dispose of any previous renderer.
    if (secondRendererRef.current) {
      secondRendererRef.current.dispose();
      if (secondCanvasRef.current.firstChild) {
        secondCanvasRef.current.removeChild(secondCanvasRef.current.firstChild);
      }
    }
    
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdddddd);
    const width = secondCanvasRef.current.clientWidth;
    const height = secondCanvasRef.current.clientHeight;
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 1, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    secondRendererRef.current = renderer;
    secondCanvasRef.current.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 7.5);
    scene.add(directionalLight);
    
    // Use GLTFLoader to load the white model.
    const loader = new GLTFLoader();
    loader.load(displayData.mesh_path, (gltf) => {
      const model = gltf.scene;
      // Load textures:
      // - The albedo texture is taken from displayData.uv_image (original albedo rgb uv)
      // - The ORM texture is loaded from ormImageUrl (to derive metallic & roughness)
      const textureLoader = new THREE.TextureLoader();
      const albedoTexture = textureLoader.load(displayData.uv_image);
      const ormTexture = textureLoader.load(ormImageUrl);
      model.traverse((child) => {
        if (child.isMesh) {
          child.material = new THREE.MeshStandardMaterial({
            map: albedoTexture,
            metalnessMap: ormTexture,
            roughnessMap: ormTexture,
            metalness: 1.0,
            roughness: 1.0,
          });
          child.material.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
              /texture2D\( metalnessMap, vUv \)\.b/g,
              'texture2D( metalnessMap, vUv ).r'
            );
            // For safety: enforce roughness to be taken from the green channel.
            shader.fragmentShader = shader.fragmentShader.replace(
              /texture2D\( roughnessMap, vUv \)\.r/g,
              'texture2D( roughnessMap, vUv ).g'
            );
          };
        }
      });
      scene.add(model);
    });
    
    const animate = () => {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    
    const handleResize = () => {
      const width = secondCanvasRef.current.clientWidth;
      const height = secondCanvasRef.current.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  };

  // useEffect to re-render the materialised model when ormImageUrl or displayData changes.
  useEffect(() => {
    if (ormImageUrl && displayData) {
      renderMaterialisedModel();
    }
  }, [ormImageUrl, displayData]);
  
  const handleDownload = () => {
    if (!sampleFolder) {
      alert("No sample folder available.");
      return;
    }
    window.open(`http://localhost:8080/download_material?sample_folder=${encodeURIComponent(sampleFolder)}`);
  };

  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <h1>MetaMesh Frontend</h1>
      {/* Section 1 */}
      <div style={{ border: '1px solid #ccc', padding: '20px', marginBottom: '40px' }}>
        <h2>Section 1: Background Removal & Run Model (Port 8000)</h2>
        <input type="file" accept="image/png" onChange={handleFileChange} />
        {/* New block to display the original file preview */}
        {originalImageUrl && (
          <div>
            <h3>Original File Preview:</h3>
            <img src={originalImageUrl} alt="Original File" style={{ maxWidth: '300px', margin: '0 auto', display: 'block' }} />
          </div>
        )}
        <div style={{ margin: '10px 0' }}>
          <label>
            Foreground Ratio ({foregroundRatio}):
            <input type="range" min="0.5" max="1" step="0.01" value={foregroundRatio}
              onChange={(e) => setForegroundRatio(e.target.value)} style={{ marginLeft: '10px' }} />
          </label>
        </div>
        <div style={{ margin: '10px 0' }}>
          <label>
            Remesh Option:
            <select value={remeshOption} onChange={(e) => setRemeshOption(e.target.value)} style={{ marginLeft: '10px' }}>
              <option value="none">None</option>
              <option value="triangle">Triangle</option>
              <option value="quad">Quad</option>
            </select>
          </label>
        </div>
        <div style={{ margin: '10px 0' }}>
          <label>
            Target Vertex Count ({vertexCount}):
            <input type="range" min="-1" max="19999" value={vertexCount}
              onChange={(e) => setVertexCount(e.target.value)} style={{ marginLeft: '10px' }} />
          </label>
        </div>
        <div style={{ margin: '10px 0' }}>
          <label>
            Texture Size ({textureSize}):
            <input type="range" min="512" max="2048" value={textureSize}
              onChange={(e) => setTextureSize(e.target.value)} style={{ marginLeft: '10px' }} />
          </label>
        </div>
        {previewImage && (
          <div>
            <h3>Background Removed Preview:</h3>
            <img src={previewImage} alt="Preview" style={{ maxWidth: '300px', margin: '0 auto', display: 'block' }} />
          </div>
        )}
        {previewImage && (
          <div style={{ marginTop: '10px' }}>
            <button onClick={handleRunModel}>Run Model</button>
          </div>
        )}
        {errorMessage && <div style={{ color: 'red' }}>Error: {errorMessage}</div>}
        <div ref={canvasContainerRef} style={{ width: '80vw', height: '60vh', border: '1px solid #ccc', margin: '20px auto' }} />
      </div>

      {/* Section 2 */}
      <div style={{ border: '1px solid #ccc', padding: '20px' }}>
        <h2>Section 2: White Model Display & Materialisation (Port 8080)</h2>
        {sampleFolder ? (
          <div style={{ marginBottom: '10px' }}>
            <strong>Sample Folder:</strong> {sampleFolder}
          </div>
        ) : (
          <div style={{ marginBottom: '10px', color: 'red' }}>No sample folder available yet. Please run Section 1.</div>
        )}
        <div style={{ marginBottom: '10px' }}>
          <label>
            Category:
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ marginLeft: '10px' }}>
              {categoryOptions.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ marginTop: '10px' }}>
          <button onClick={handleLoadWhiteModel}>Load White Model</button>
        </div>
        {displayData && (
          <div style={{ marginTop: '20px' }}>
            <h3>White Model & Albedo Texture Preview</h3>
            {displayData.uv_image && (
              <img src={displayData.uv_image} alt="Albedo Texture" style={{ maxWidth: '300px', display: 'block', margin: '0 auto' }} />
            )}
            <div style={{ marginTop: '10px' }}>
              <strong>Mesh File:</strong> {displayData.mesh_path}
            </div>
          </div>
        )}
        {displayData && (
          <div style={{ marginTop: '20px' }}>
            <button onClick={handleRender}>Render (Views & Segmentation)</button>
          </div>
        )}
        {renderViews && segViews && (
          <div style={{ marginTop: '20px' }}>
            <h3>Rendered Views</h3>
            <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap' }}>
              {renderViews.map((img, idx) => (
                <img key={idx} src={img} alt={`View ${idx + 1}`} style={{ width: '150px', margin: '5px' }} />
              ))}
            </div>
            <h3>Segmentation Views</h3>
            <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap' }}>
              {segViews.map((img, idx) => (
                <img key={idx} src={img} alt={`Segmentation ${idx + 1}`} style={{ width: '150px', margin: '5px' }} />
              ))}
            </div>
          </div>
        )}
        {renderViews && segViews && (
          <div style={{ marginTop: '20px' }}>
            <button onClick={handleMaterialise}>Materialise</button>
          </div>
        )}
        {ormImageUrl && (
          <div style={{ marginTop: '20px' }}>
            <h3>ORM UV Map</h3>
            <img src={ormImageUrl} alt="ORM Map" style={{ maxWidth: '300px', margin: '0 auto', display: 'block' }} />
          </div>
        )}
        <div ref={secondCanvasRef} style={{ width: '80vw', height: '60vh', border: '1px solid #ccc', margin: '20px auto' }} />
        {ormImageUrl && (
          <div style={{ marginTop: '20px' }}>
            <button onClick={handleDownload}>Download All Generated Files</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
