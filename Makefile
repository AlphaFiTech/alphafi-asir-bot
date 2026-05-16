.PHONY: fmt lint typecheck build pre-commit ci

fmt:
	npm run fmt

lint:
	npm run lint

typecheck:
	npm run typecheck

build:
	docker build -t alphafi-betterstack .

pre-commit:
	pre-commit run --all-files

ci: typecheck lint fmt
	@echo "CI checks passed"
