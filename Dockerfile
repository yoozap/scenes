# Build the Vite bundle, then serve the static output with nginx.
# One pod, one scene. THIS BRANCH IS SCENE 2's POD.
#
# usectl builds from a git ref and has no way to pass a --build-arg, and
# SCENE is needed at BUILD time (it decides which page becomes index.html),
# not at deploy time where a pod env var would land. So the scene is pinned
# by the branch instead: main keeps ARG SCENE=1 and feeds the car-tunnel
# pod, this branch flips the default and feeds car-drift. The only
# difference between the two branches is the number on the next line.
FROM node:22-alpine AS build
ARG SCENE=2
ENV SCENE=$SCENE
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Cache-Control and the .glb mime type; see the file for why each rule exists.
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
