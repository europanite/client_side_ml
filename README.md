# [Client Side ML](https://github.com/europanite/client_side_ml "Client Side ML")

[![GitHub Pages](https://github.com/europanite/client_side_ml/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/europanite/client_side_ml/actions/workflows/deploy-pages.yml)

!["web_ui"](./assets/images/web_ui.png)

 [PlayGround](https://europanite.github.io/client_side_ml/)

Client Side Browser-Based CART Time-Series Prediction. 

---

## Data Structure

<pre>
datetime,item_a,item_b,item_c,...
2025-01-01 00:00:00+09:00,10,20,31,...
2025-01-02 00:00:00+09:00,12,19,31,...
2025-01-03 00:00:00+09:00,14,18,33,...
 ...
</pre>

---

## 🚀 Getting Started

### 1. Prerequisites
- [Docker Compose](https://docs.docker.com/compose/)

### 2. Build and start all services:

```bash
# set environment variables:
export REACT_NATIVE_PACKAGER_HOSTNAME=${YOUR_HOST}

# Build the image
docker compose build

# Run the container
docker compose up
```

### 3. Test:
```bash
docker compose \
-f docker-compose.test.yml up \
--build --exit-code-from \
frontend_test
```

---

# License
- Apache License 2.0