// This module implements a map viewer allowing to position floor plans

import { LAYERS } from '/js/components/datasources.mjs';
import { BoundingBox2, Matrix2, Point2, Vector2 } from '/js/linalg.mjs';
import { Stylable } from '/js/mixins.mjs';
import { createElement as E } from '/js/util.mjs';
import '/js/leaflet.js';
import '/js/Leaflet.ImageOverlay.Rotated.js';

const AVERAGE_EARTH_RADIUS = 6_371_008.771

// Compute a degree cosinus
function dcos(a) {
    return Math.cos(a * Math.PI / 180);
}

// Compute the Haversine distance between two points
function hav(p1, p2) {
    return Math.asin(Math.sqrt ((1 - dcos(p2.lat - p1.lat) + dcos(p1.lat) * dcos(p2.lat) *
                                 (1 - dcos(p2.lng - p1.lng))) / 2)) * 2 * AVERAGE_EARTH_RADIUS;
}

class WorldMap extends Stylable(HTMLElement) {
    #anchors;
    #currentLayer;
    #map;
    #overlay;
    #scale;

    constructor() {
        super();

        this.addStylesheet('components/world-map.css');
        this.addStylesheet('leaflet.css');
        this.addStylesheet('style.css');

        const mapDiv = this.appendToShadow(E('div'));
        // Show Brest, FR, by default
        this.#map = L.map(mapDiv, { center: [48.383313, -4.497187], zoom: 14 });

        this.#currentLayer = L.tileLayer(LAYERS.osm.layer, {
            minZoom: 0,
            maxZoom: 20,
            tileSize: 256,
            attribution: LAYERS.osm.attribution,
            maxNativeZoom: LAYERS.osm.maxZoom
        });
        this.#currentLayer.addTo(this.#map);

        const layers = E('select');
        for (const layer in LAYERS)
            layers.appendElement({ tag: 'option', attributes: { value: layer }, content: LAYERS[layer].name });
        this.appendToShadow(layers);
        layers.addEventListener('change', e => {
            this.#map.removeLayer(this.#currentLayer);
            const layer = LAYERS[e.target.value];
            this.#currentLayer = L.tileLayer(layer.layer, {
                minZoom: 0,
                maxZoom: 20,
                tileSize: 256,
                attribution: layer.attribution,
                maxNativeZoom: layer.maxZoom
            });
            this.#currentLayer.addTo(this.#map);
        });

        this.#anchors = null;
        this.#scale = null;

        this.#overlay = null;
        new ResizeObserver(() => this.#map.invalidateSize()).observe(mapDiv);

        fetch(`${window.apiURL}/maps`).then(response => {
            if (!response.ok)
                throw new Error(`Failed to load maps (${response.status})`);
            return response.json();
        }).then(ids => {
            ids.forEach(id => {
                fetch(`${window.apiURL}/maps/${id}`).then(response => {
                    if (!response.ok)
                        throw new Error(`Failed to load map ${id} (${response.status})`);
                    return response.json();
                }).then(data => {
                    const srcAnchors = [];
                    const dstAnchors = [];
                    for (const anchor of data.anchors) {
                        srcAnchors.push(new Point2(anchor.x, anchor.y));
                        dstAnchors.push(new Point2(anchor.lng, anchor.lat));
                    }
                    const srcRect = new Point2(data.width, data.height);
                    const filename = data.path.split('/').pop();
                    this.updateOverlay(srcAnchors, srcRect, `${window.apiURL}/data/${filename}`, dstAnchors);
                    this.#overlay = null;
                }).catch(err => {
                    alert(err);
                });
            });
        }).catch(err => {
            alert(err);
        });
    }

    connectedCallback() {
        document.worldMap = this;
        document.getElementById('place').addEventListener('click', this.#placeFloorplan.bind(this));
        document.getElementById('unplace').addEventListener('click', () => {
            this.#overlay.remove();
            this.#overlay = null;
            this.#anchors.forEach(e => e.remove());
            this.#anchors = null;
        });
    }

    // Initialize the anchors on the map
    #initAnchors() {
        this.#anchors = [];
        for (let i = 0; i < 3; i++) {
            const anchor = L.marker({ lng: 0, lat: 0 }, {
                draggable: true,
                icon: L.divIcon({ className: 'anchor', iconSize: [24, 24], iconAnchor: [12, 12] })
            }).addTo(this.#map);
            anchor.on('drag', () =>
              this.updateOverlay(document.floorplanContainer.getAnchors(),
                                 document.floorplanContainer.getDimensions(),
                                 document.floorplanContainer.getAttribute('src')));
            this.#anchors.push(anchor);
        }
    }

    // Place the floorplan on the map
    #placeFloorplan() {
        if (this.#anchors === null)
            this.#initAnchors();

        const rect = this.getBoundingClientRect();
        const mapRect = this.#map.getBounds();
        const box = new BoundingBox2(new Point2(mapRect.getWest(), mapRect.getSouth()),
                                     new Point2(mapRect.getEast(), mapRect.getNorth()));

        // Here, we want to make it so that our box is a square in the user viewport. WGS84 can be a
        // bit tricky, as the box/viewport mapping is not constant across latitudes, so we have to
        // take that into account. We also downscale the viewport by 10%, to display a margin.
        let halfDeltaX, halfDeltaY;
        if (rect.width > rect.height) {
            halfDeltaX = box.width() * (.05 + .45 * (rect.width - rect.height) / rect.width);
            halfDeltaY = .05 * box.height();
        }
        else {
            halfDeltaX = .05 * box.width();
            halfDeltaY = box.height() * (.05 + .45 * (rect.height - rect.width) / rect.height);
        }
        box.max.x -= halfDeltaX;
        box.min.x += halfDeltaX;
        box.max.y -= halfDeltaY;
        box.min.y += halfDeltaY;

        // Now that we have a square, we want to crop it so that the box has the same aspect ratio
        // as the floorplan in the user viewport
        const fpRect = document.floorplanContainer.getDimensions();
        if (fpRect.x > fpRect.y) {
            const halfDelta = box.height() * (fpRect.x - fpRect.y) / fpRect.x / 2;
            box.max.y -= halfDelta;
            box.min.y += halfDelta;
        }
        else {
            const halfDelta = box.width() * (fpRect.y - fpRect.x) / fpRect.y / 2;
            box.max.x -= halfDelta;
            box.min.x += halfDelta;
        }

        // We can now properly interpolate the anchors
        const floorplanAnchors = document.floorplanContainer.getAnchors();
        for (let i = 0; i < 3; i++) {
            this.#anchors[i].setLatLng({
                lng: box.min.x + floorplanAnchors[i].x * box.width() / fpRect.x,
                lat: box.max.y - floorplanAnchors[i].y * box.height() / fpRect.y
            });
        }
        this.updateOverlay(floorplanAnchors, fpRect,
                           document.floorplanContainer.getAttribute('src'));
    }

    #getDstAnchors() {
        const dstAnchors = [];
        for (const anchor of this.#anchors ?? []) {
            const { lat, lng } = anchor.getLatLng();
            dstAnchors.push(new Point2(lng, lat));
        }
        return dstAnchors;
    }

    // Update the overlay with the proper viewport and transformation
    updateOverlay(srcAnchors, srcRect, url, dstAnchors = null) {
        this.#scale = null;
        const anchors = dstAnchors ?? this.#getDstAnchors();
        if (anchors.length !== 3)
            return;

        const transformation = this.#computeTransformation(srcAnchors, anchors);
        if (transformation === null) {
            return;
        }
        const corners = [
            new Point2(0, 0),
            new Point2(srcRect.x, 0),
            new Point2(0, srcRect.y),
        ].map(p => {
            const { x, y } = transformation[0].appliedTo(p).plus(transformation[1]);
            return L.latLng(y, x);
        });

        if (dstAnchors === null)
            this.#scale = new Vector2(srcRect.x, srcRect.y).norm() / hav(corners[1], corners[2]);

        if (this.#overlay === null)
            this.#overlay = L.imageOverlay.rotated(url, ...corners,
                                                   { opacity: .7 }).addTo(this.#map);
        else
            this.#overlay.reposition(...corners);
    }

    // Compute the transformation matrix
    #computeTransformation(src, dst) {
        const srcV1 = src[0].to(src[1]);
        const srcV2 = src[0].to(src[2]);
        const dstV1 = dst[0].to(dst[1]);
        const dstV2 = dst[0].to(dst[2]);
        const det = srcV1.cross(srcV2);

        // Return early if the anchors are colinear
        if (Math.abs(det) < 1e-12) {
            return null;
        }

        const a = (dstV1.x * srcV2.y - dstV2.x * srcV1.y) / det;
        const c = (dstV1.y * srcV2.y - dstV2.y * srcV1.y) / det;
        const b = (-dstV1.x * srcV2.x + dstV2.x * srcV1.x) / det;
        const d = (-dstV1.y * srcV2.x + dstV2.y * srcV1.x) / det;
        const dx = dst[0].x - a * src[0].x - b * src[0].y;
        const dy = dst[0].y - c * src[0].x - d * src[0].y;
        return [new Matrix2(a, b, c, d), new Vector2(dx, dy)];
    }

    // Get an approximate pixel/meter scale
    getScale() {
        return this.#scale;
    }

    // Return serialized data
    toJSON() {
        return this.#anchors.map(e => e.getLatLng());
    }
}


try {
    customElements.define('world-map', WorldMap);
}
catch (e) {
  if (!(e instanceof DOMException))
    throw e;
}
