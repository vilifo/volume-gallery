"""Intensity histogram of a volume, shown behind the viewer's transfer function curve.

Stored as <volume dir>/histogram.json (next to the Zarr store, so it is deleted with the
volume):

    {"version": 1, "dtype": "uint16", "min": 0, "max": 40211, "bins": 1024, "counts": [...]}

`counts` is a histogram of the finest resolution level over [min, max] (the data's own
range). kiln-render draws its histogram over the transfer function's whole intensity axis
(for 16-bit data 0..65535), so the viewer resamples these counts onto that axis
(frontend/js/histogram.js); min and max are stored for exactly that.
"""
import json
import os
from pathlib import Path
from typing import Tuple

import dask
import dask.array as da
import numpy as np
import zarr

from ..config import settings
from .volume import _read_group_attrs, get_multiscales

