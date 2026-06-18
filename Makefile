.PHONY: install build dev test clean

install:
	npm install

build:
	npm run build

dev:
	npm run dev

test:
	npm test

clean:
	rm -rf dist node_modules
